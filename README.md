# Lucky Bangla – Custom Node.js Backend

Supabase শুধু **database** (ও Auth) এর জন্য। সব business logic এই backend এ।

## Setup

```bash
cd backend
cp .env.example .env
# Edit .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
npm install
npm run dev
```

Server চালু হবে: `http://localhost:4000`

## API Endpoints

| Method | Path | Auth | বর্ণনা |
|--------|------|------|--------|
| GET | `/health` | - | Health check |
| GET | `/api/app-version` | - | App version for auto-update (version, versionCode, downloadUrl, forceUpdate) |
| POST | `/api/rpc/:name` | Bearer | RPC proxy – body তে params (যেমন `{ p_user_id, p_amount }`) |
| POST | `/api/admin/set-password` | Admin | Body: `{ user_id, password }` |
| POST | `/api/admin/approve-agent` | Admin | Body: `{ application_id, password }` |
| POST | `/api/stats/sync-game-stats` | Admin | game_stats_summary সিঙ্ক |
| POST | `/api/games/outcome` | Bearer | Body: `{ bet_amount, game_type?, game_id? }` – generic game outcome |
| POST | `/api/games/color-prediction-outcome` | Bearer | Body: `{ bet_amount, bet_type, bet_value, period_id? }` |
| POST | `/api/games/boxing-king-spin` | Bearer | Stub (501) – logic port করা বাকি |
| POST | `/api/games/super-ace-spin` | Bearer | Stub (501) – logic port করা বাকি |
| GET | `/api/payments/deposit-form-data` | Bearer | E-wallet deposit form data |
| GET | `/api/payments/withdraw-form-data` | Bearer | E-wallet withdraw form data |
| GET | `/api/payments/lucky-agent-data` | Bearer | Lucky Agent list, methods, agent numbers |
| GET | `/api/payments/check-deposit-trx?trx_id=` | Bearer | Check duplicate TrxID |
| POST | `/api/payments/deposits` | Bearer | Create deposit request |
| POST | `/api/payments/withdrawals` | Bearer | Create withdrawal (deduct + insert) |
| GET | `/api/payments/withdrawals` | Bearer | List withdrawals (agent/admin) |
| POST | `/api/payments/withdrawals/:id/reject` | Bearer | Reject withdrawal |

## Frontend থেকে ব্যবহার

- আগে যেখানে `supabase.rpc('adjust_wallet_balance', { ... })` call হত, সেখানে এখন backend call করুন:  
  `POST /api/rpc/adjust_wallet_balance` with same body, header `Authorization: Bearer <jwt>`.
- Game outcome এর জন্য আগে Edge Function invoke হত; এখন `POST /api/games/outcome` বা `POST /api/games/color-prediction-outcome` use করুন।
- Admin: `POST /api/admin/set-password`, `POST /api/admin/approve-agent` – same body as before.

## Environment

- `SUPABASE_URL` – Supabase project URL  
- `SUPABASE_SERVICE_ROLE_KEY` – Backend only, full DB access  
- `SUPABASE_ANON_KEY` – Optional, for auth.getUser from token  
- `PORT` – Default 4000  
- `APP_VERSION` – App version for auto-update (e.g. 1.0.2)  
- `APP_VERSION_CODE` – Integer version code (e.g. 3)  
- `APP_DOWNLOAD_URL` – APK download URL for update  
- `APP_FORCE_UPDATE` – Set to `true` to force update (skip "Later" button)  
