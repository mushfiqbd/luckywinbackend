require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const adminRoutes = require('./routes/admin');
const statsRoutes = require('./routes/stats');
const gamesRoutes = require('./routes/games');
const crashRoutes = require('./routes/crash');
const rpcRoutes = require('./routes/rpc');
const paymentsRoutes = require('./routes/payments');
const pushRoutes = require('./routes/push');
const dailySpinRoutes = require('./routes/dailySpin');
const appVersionRoutes = require('./routes/appVersion');

const app = express();
const PORT = process.env.PORT || 4000;

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable for API
  crossOriginEmbedderPolicy: false,
}));

// Compression middleware (gzip)
app.use(compression());

// CORS - restrict to specific domains in production
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:5173', 'http://localhost:3000'];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || origin.includes('luckywinbd')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests from this IP, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Stricter rate limit for game endpoints
const gameLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // limit each IP to 20 game requests per minute
  message: { error: 'Too many game requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/games/', gameLimiter);

// Request parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Response time monitoring middleware
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    
    // Log slow requests (>1s)
    if (duration > 1000) {
      console.warn(`[SLOW] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    }
    
    // In development, log all requests
    if (process.env.NODE_ENV === 'development') {
      console.log(`[REQ] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    }
  });
  
  next();
});

// Health check with uptime info
app.get('/health', (req, res) => {
  res.json({ 
    ok: true, 
    service: 'lucky-bangla-backend',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Cache stats endpoint (for monitoring)
app.get('/api/cache/stats', (req, res) => {
  try {
    const cache = require('./services/cache');
    res.json(cache.getStats());
  } catch (err) {
    res.status(500).json({ error: 'Cache stats unavailable' });
  }
});

// Routes
app.use('/api/admin', adminRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/crash', crashRoutes);
app.use('/api/rpc', rpcRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/daily-spin', dailySpinRoutes);
app.use('/api/app-version', appVersionRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Centralized error handling
app.use((err, req, res, next) => {
  console.error(`[ERROR] [${new Date().toISOString()}] ${req.method} ${req.path}`, err);
  
  // Handle specific error types
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS policy violation' });
  }
  
  // Generic error (don't expose internal details)
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    error: statusCode === 500 ? 'Internal server error' : err.message,
    code: process.env.NODE_ENV === 'development' ? err.code : undefined,
  });
});

// Graceful shutdown
let server;
const gracefulShutdown = (signal) => {
  console.log(`[${signal}] Received shutdown signal, closing server...`);
  
  if (server) {
    server.close(() => {
      console.log('[SHUTDOWN] HTTP server closed');
      
      // Clear caches
      try {
        const cache = require('./services/cache');
        cache.clearAll();
        console.log('[SHUTDOWN] Cache cleared');
      } catch (err) {
        console.error('[SHUTDOWN] Error clearing cache:', err);
      }
      
      process.exit(0);
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
      console.error('[SHUTDOWN] Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔒 Allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`⚡ Compression: enabled`);
  console.log(`🛡️  Rate limiting: enabled (100 req/15min)`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

module.exports = app;
