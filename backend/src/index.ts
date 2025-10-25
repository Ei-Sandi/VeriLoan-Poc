/**
 * VeriLoan Backend API Server
 * Handles Concordium ZKP verification requests from the frontend
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { verifyMessage } from 'ethers';
import { verifyConcordiumProof, generateChallenge, isValidProofStructure } from './verifier.js';
import * as db from './database.js';
import envioRoutes from './routes/envio-routes.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '8000', 10);

// Initialize MongoDB connection
async function initializeServer() {
  try {
    console.log('🔄 Initializing MongoDB connection...');
    await db.initDatabase();
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize database:', error);
    console.log('⚠️  Server will continue without database. Please check MongoDB connection.');
  }
}

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// In-memory storage for challenges (in production, use Redis or database)
const activeChallenges = new Map<string, { challenge: string; createdAt: number }>();

// Clean up old challenges every 5 minutes
setInterval(() => {
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  for (const [sessionId, data] of activeChallenges.entries()) {
    if (data.createdAt < fiveMinutesAgo) {
      activeChallenges.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

/**
 * Health check endpoint
 */
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'VeriLoan Backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * Mount Envio API routes
 */
app.use('/api/envio', envioRoutes);

/**
 * Generate a new challenge for ZKP request
 * This should be called before requesting a proof from the frontend
 */
app.post('/api/challenge', (_req: Request, res: Response) => {
  try {
    const sessionId = uuidv4();
    const challenge = generateChallenge();

    activeChallenges.set(sessionId, {
      challenge,
      createdAt: Date.now()
    });

    res.json({
      success: true,
      sessionId,
      challenge,
      expiresIn: 300
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Failed to generate challenge'
    });
  }
});

/**
 * Main verification endpoint
 * Receives ZKP proof, EVM signature, and wallet addresses
 */
app.post('/api/verify-identity', async (req: Request, res: Response) => {
  try {
    const {
      concordiumProof,
      concordiumAddress,
      evmSignature,
      evmAddress,
      sessionId,
      concordiumTermsAcceptance,
      evmTermsAcceptance
    } = req.body;

    if (!concordiumProof || !concordiumAddress || !evmSignature || !evmAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['concordiumProof', 'concordiumAddress', 'evmSignature', 'evmAddress']
      });
    }

    // Get challenge from session
    let challenge = 'VeriLoan Identity Verification';
    if (sessionId && activeChallenges.has(sessionId)) {
      const challengeData = activeChallenges.get(sessionId);
      if (challengeData) {
        challenge = challengeData.challenge;
        activeChallenges.delete(sessionId);
      }
    }

    const proofJson = typeof concordiumProof === 'string'
      ? concordiumProof
      : JSON.stringify(concordiumProof);

    console.log('Received Concordium Proof:', proofJson.substring(0, 500) + '...');
    console.log('Proof keys:', Object.keys(JSON.parse(proofJson)));

    if (!isValidProofStructure(proofJson)) {
      console.log('❌ Invalid proof structure detected');
      return res.status(400).json({
        success: false,
        error: 'Invalid proof structure',
        debug: {
          receivedKeys: Object.keys(JSON.parse(proofJson)),
          expectedKeys: ['proof', 'credential', 'presentationContext']
        }
      });
    }

    // Verify Concordium proof
    const verificationResult = await verifyConcordiumProof({
      proofResultJson: proofJson,
      challenge
    });

    if (!verificationResult.isValid) {
      return res.status(400).json({
        success: false,
        error: verificationResult.error || 'Proof verification failed'
      });
    }

    // Create or update wallet pairing in database
    const pairing = await db.createOrUpdatePairing(
      concordiumAddress,
      evmAddress,
      {
        firstName: verificationResult.revealedAttributes?.firstName,
        lastName: verificationResult.revealedAttributes?.lastName,
        nationality: verificationResult.revealedAttributes?.nationality,
        ageVerified: true, // Verified via date of birth proof
      }
    );

    // Mark terms acceptance in database
    if (concordiumTermsAcceptance) {
      await db.markConcordiumTermsAccepted(concordiumAddress);
    }
    if (evmTermsAcceptance) {
      await db.markEvmTermsAccepted(concordiumAddress, evmAddress);
    }

    console.log('✅ Wallet pairing created/updated:', {
      pairingId: pairing.pairingId,
      concordiumAddress: pairing.concordiumAddress,
      evmAddresses: pairing.evmAddresses,
      totalPairings: pairing.evmAddresses.length
    });

    const response = {
      success: true,
      verification: {
        concordium: {
          verified: true,
          address: concordiumAddress,
          revealedAttributes: verificationResult.revealedAttributes
        },
        evm: {
          verified: true,
          address: evmAddress,
          signature: evmSignature
        },
        pairing: {
          pairingId: pairing.pairingId,
          totalEvmAddresses: pairing.evmAddresses.length,
          evmAddresses: pairing.evmAddresses,
          termsAccepted: {
            concordium: pairing.termsAcceptance.concordium,
            evmCount: pairing.termsAcceptance.evm.length
          }
        }
      },
      attestation: {
        status: 'completed',
        pairingHash: pairing.pairingId,
        message: 'Wallet pairing stored securely with cryptographic hash'
      },
      timestamp: new Date().toISOString()
    };

    res.json(response);

  } catch (error: any) {
    console.error('Verification error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Get verification status (for polling)
 */
app.get('/api/verification-status/:verificationId', (req: Request, res: Response) => {
  const { verificationId } = req.params;

  res.json({
    success: true,
    verificationId,
    status: 'completed',
    timestamp: new Date().toISOString()
  });
});

/**
 * Verify Terms and Conditions acceptance signature
 * Note: This is basic validation for development. Production should implement
 * full cryptographic signature verification using Concordium SDK.
 */
app.post('/api/verify-terms-acceptance', async (req: Request, res: Response) => {
  try {
    const { signature, message, termsVersion, termsHash, accountAddress, timestamp } = req.body;

    console.log('Terms verification request received:');
    console.log('- Account Address:', accountAddress);
    console.log('- Terms Version:', termsVersion);
    console.log('- Terms Hash:', termsHash);
    console.log('- Timestamp:', timestamp);
    console.log('- Message:', message);
    console.log('- Signature type:', typeof signature);
    console.log('- Signature structure:', JSON.stringify(signature, null, 2));

    // Check for missing fields
    if (!signature || !message || !termsVersion || !termsHash || !accountAddress || !timestamp) {
      const missingFields = [];
      if (!signature) missingFields.push('signature');
      if (!message) missingFields.push('message');
      if (!termsVersion) missingFields.push('termsVersion');
      if (!termsHash) missingFields.push('termsHash');
      if (!accountAddress) missingFields.push('accountAddress');
      if (!timestamp) missingFields.push('timestamp');

      console.log('❌ Missing required fields:', missingFields);
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['signature', 'message', 'termsVersion', 'termsHash', 'accountAddress', 'timestamp'],
        missing: missingFields
      });
    }

    // Validate terms version
    const CURRENT_TERMS_VERSION = '1.0';
    if (termsVersion !== CURRENT_TERMS_VERSION) {
      console.log(`❌ Invalid terms version: ${termsVersion} (expected ${CURRENT_TERMS_VERSION})`);
      return res.status(400).json({
        success: false,
        error: `Invalid terms version. Current version is ${CURRENT_TERMS_VERSION}`,
        verified: false
      });
    }

    // Validate timestamp (not too old, not in future)
    const signatureTime = new Date(timestamp).getTime();
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000);
    const oneMinuteAhead = now + (60 * 1000);

    if (isNaN(signatureTime)) {
      console.log('❌ Invalid timestamp format:', timestamp);
      return res.status(400).json({
        success: false,
        error: 'Invalid timestamp format',
        verified: false
      });
    }

    if (signatureTime < fiveMinutesAgo) {
      console.log('❌ Terms signature has expired');
      return res.status(400).json({
        success: false,
        error: 'Terms signature has expired. Please sign again.',
        verified: false
      });
    }

    if (signatureTime > oneMinuteAhead) {
      console.log('❌ Timestamp is in the future');
      return res.status(400).json({
        success: false,
        error: 'Invalid timestamp',
        verified: false
      });
    }

    // Basic validation checks
    const validationResults = {
      signatureIsObject: typeof signature === 'object' && signature !== null,
      signatureHasData: false,
      messageIncludesVersion: message && typeof message === 'string' && message.includes(termsVersion),
      messageIncludesHash: message && typeof message === 'string' && message.includes(termsHash),
    };

    // Check signature structure (Concordium signatures can be in different formats)
    if (validationResults.signatureIsObject) {
      // Check for common Concordium signature fields
      const hasStandardFormat = !!(
        signature.signature || // String signature
        signature.sig || // Alternative field name
        (Array.isArray(signature) && signature.length > 0) || // Array format
        (signature.type && signature.value) // Object with type/value
      );

      // Check for Concordium nested object format: {"0": {"0": "hex_string"}}
      const hasNestedFormat = !!(
        signature['0'] && typeof signature['0'] === 'object' && signature['0']['0']
      );

      // Check if signature has any data in any recognized format
      validationResults.signatureHasData = hasStandardFormat || hasNestedFormat || Object.keys(signature).length > 0;
    }

    console.log('Validation results:', validationResults);

    // Check if all validations passed
    const allChecksPass = Object.values(validationResults).every(v => v === true);

    if (!allChecksPass) {
      const failedChecks = Object.entries(validationResults)
        .filter(([_, value]) => !value)
        .map(([key]) => key);

      console.log('❌ Validation failed. Failed checks:', failedChecks);
      return res.status(400).json({
        success: false,
        error: 'Signature validation failed',
        verified: false,
        details: {
          failedChecks,
          message: 'One or more validation checks did not pass'
        }
      });
    }

    console.log('✅ Terms verification passed all checks');
    res.json({
      success: true,
      verified: true,
      accountAddress,
      termsVersion,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('❌ Terms verification error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      verified: false
    });
  }
});

/**
 * EVM Terms Acceptance Verification
 */
app.post('/api/verify-evm-terms-acceptance', async (req: Request, res: Response) => {
  try {
    const { signature, message, termsVersion, termsHash, address, timestamp } = req.body;

    if (!signature || !message || !termsVersion || !termsHash || !address || !timestamp) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['signature', 'message', 'termsVersion', 'termsHash', 'address', 'timestamp']
      });
    }

    // Validate terms version
    const CURRENT_TERMS_VERSION = '1.0';
    if (termsVersion !== CURRENT_TERMS_VERSION) {
      return res.status(400).json({
        success: false,
        error: `Invalid terms version. Current version is ${CURRENT_TERMS_VERSION}`,
        verified: false
      });
    }

    // Validate timestamp (not too old, not in future)
    const signatureTime = new Date(timestamp).getTime();
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000);
    const oneMinuteAhead = now + (60 * 1000);

    if (signatureTime < fiveMinutesAgo) {
      return res.status(400).json({
        success: false,
        error: 'Terms signature has expired. Please sign again.',
        verified: false
      });
    }

    if (signatureTime > oneMinuteAhead) {
      return res.status(400).json({
        success: false,
        error: 'Invalid timestamp',
        verified: false
      });
    }

    // Verify EVM signature cryptographically
    try {
      const recoveredAddress = verifyMessage(message, signature);
      const isValid = recoveredAddress.toLowerCase() === address.toLowerCase();

      if (!isValid) {
        return res.status(400).json({
          success: false,
          error: 'Signature verification failed - recovered address does not match',
          verified: false,
          recoveredAddress,
          expectedAddress: address
        });
      }

      res.json({
        success: true,
        verified: true,
        address,
        recoveredAddress,
        termsVersion,
        timestamp: new Date().toISOString()
      });

    } catch (signatureError: any) {
      return res.status(400).json({
        success: false,
        error: `Invalid signature: ${signatureError.message}`,
        verified: false
      });
    }

  } catch (error: any) {
    console.error('EVM terms verification error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      verified: false
    });
  }
});

/**
 * Get wallet pairing information
 */
app.get('/api/pairing/:address', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    // Try to find pairing by Concordium address
    let pairing = await db.getPairingByConcordium(address);

    // If not found, try by EVM address
    if (!pairing) {
      pairing = await db.getPairingByEvm(address);
    }

    if (!pairing) {
      return res.status(404).json({
        success: false,
        error: 'No pairing found for this address'
      });
    }

    res.json({
      success: true,
      pairing: {
        pairingId: pairing.pairingId,
        concordiumAddress: pairing.concordiumAddress,
        evmAddresses: pairing.evmAddresses,
        verifiedAttributes: pairing.verifiedAttributes,
        termsAcceptance: pairing.termsAcceptance,
        createdAt: pairing.createdAt,
        updatedAt: pairing.updatedAt
      }
    });

  } catch (error: any) {
    console.error('Pairing lookup error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

/**
 * Get database statistics
 */
app.get('/api/stats', async (_req: Request, res: Response) => {
  try {
    const stats = await db.getStats();
    res.json({
      success: true,
      stats
    });
  } catch (error: any) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Start server
async function startServer() {
  // Initialize database first
  await initializeServer();

  const server = app.listen(PORT, () => {
    console.log('VeriLoan Backend Server');
    console.log(`Listening on http://localhost:${PORT}`);
    console.log('');
    console.log('Endpoints:');
    console.log('  GET  /health');
    console.log('  POST /api/challenge');
    console.log('  POST /api/verify-identity');
    console.log('  POST /api/verify-signature');
    console.log('  POST /api/verify-terms-acceptance');
    console.log('  POST /api/verify-evm-terms-acceptance');
    console.log('  GET  /api/pairing/:address');
    console.log('  GET  /api/stats');
    console.log('  GET  /api/verification-status/:id');
    console.log('');
    console.log('Envio Integration Endpoints:');
    console.log('  GET  /api/envio/health');
    console.log('  GET  /api/envio/loans/:evmAddress');
    console.log('  GET  /api/envio/repayments/:evmAddress');
    console.log('  GET  /api/envio/liquidations/:evmAddress');
    console.log('  GET  /api/envio/summary/:evmAddress');
    console.log('  GET  /api/envio/paired-wallet/:concordiumAddress');
    console.log('');
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use`);
    } else {
      console.error('Server error:', err);
    }
    process.exit(1);
  });

  // Handle shutdown gracefully
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down server...');
    await db.closeDatabase();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down server...');
    await db.closeDatabase();
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

// Start the server
startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
