require('dotenv').config();
const express = require('express');
const cors = require('cors');

const adminRoutes = require('./routes/admin');
const statsRoutes = require('./routes/stats');
const gamesRoutes = require('./routes/games');
const crashRoutes = require('./routes/crash');
const rpcRoutes = require('./routes/rpc');
const paymentsRoutes = require('./routes/payments');
const dailySpinRoutes = require('./routes/dailySpin');
const appVersionRoutes = require('./routes/appVersion');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: true }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'lucky-bangla-backend' }));

app.use('/api/admin', adminRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/crash', crashRoutes);
app.use('/api/rpc', rpcRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/daily-spin', dailySpinRoutes);
app.use('/api/app-version', appVersionRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
