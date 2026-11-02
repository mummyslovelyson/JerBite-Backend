# JerBite Backend API

Node.js, Express, and PostgreSQL backend service for the JerBite food ordering and delivery platform.

## Architecture & Features

- **Authentication & RBAC:** Dedicated authentication routes and sessions for Customers, Restaurant Kitchen Managers, Delivery Riders, and Platform Administrators.
- **Database Migrations:** Automated PostgreSQL migrations (`001` through `005`) for complete schema integrity, audit logs, order tracking, and settings.
- **Order Lifecycle & KDS:** Kitchen display system, live dispatch, and multi-status order lifecycle (`placed`, `accepted`, `preparing`, `ready`, `picked_up`, `delivered`, `cancelled`).
- **Payments & Audit:** Mock & live payment webhooks, settlement logs, commission calculations, and security audit trails.

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` and fill in your PostgreSQL connection string and secrets:
```bash
cp .env.example .env
```

### 3. Run Database Migrations
```bash
npm run migrate
```

### 4. Seed Administrator Account
```bash
npm run seed:admin
# Default credentials:
# Email: admin@foodapp.com
# Password: AdminPassword123!
```

### 5. Start Development Server
```bash
npm run dev
# Server runs on http://localhost:5001
```

### 6. Production Deployment
```bash
npm start
```
