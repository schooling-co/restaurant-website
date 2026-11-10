# Restaurant Website & Online Ordering

A complete starter app for a restaurant: responsive public site, server-validated online orders, owner dashboard, QR codes per table, and optional Stripe Checkout. Orders and menu/table data are stored in SQLite.

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set `OWNER_PASSWORD` and `TOKEN_SECRET` to strong private values.
3. Install dependencies and start the app:

   ```bash
   npm install
   npm start
   ```

4. Open http://localhost:3000. The database is created automatically as `data/restaurant.sqlite` and seeded with sample dishes and tables.
5. Click **Owner portal** and use the password you set in `.env`.

Do not commit `.env` or share your owner password. The owner portal is protected by a signed, expiring token; orders and totals are validated by the server, not trusted from the browser.

## Online orders and payments

Customers can add menu items to their cart, choose pickup or dine-in, provide contact details, and submit an order. Orders are saved in SQLite and appear in the owner dashboard, where staff can update order status. Dine-in orders can be associated with a table using its QR code.

By default, customers can submit a real order and pay at the restaurant. To accept card payments, configure Stripe:

- Set `STRIPE_SECRET_KEY` in the deployment environment.
- Set `BASE_URL` to the public HTTPS address of your deployed app.
- Configure a Stripe webhook at `https://YOUR-DOMAIN/api/stripe/webhook` for `checkout.session.completed` and `checkout.session.expired`, then set its signing secret as `STRIPE_WEBHOOK_SECRET`.
- Card payments are only marked paid after the signed webhook confirms payment. Do not treat the browser success redirect as proof of payment.

Never put Stripe secret keys in frontend code or commit them to the repository. Test Stripe integration with Stripe test-mode keys before accepting live payments.

## Table QR codes

Each table's QR code links to this app with a distinct `?table=TABLE_ID` parameter. On a deployed site the codes use that site's URL. Scanning the code opens the menu and preselects dine-in ordering for that table. Print QR codes from the owner portal after deployment so the printed codes point to the public site.

## Deployment

Deploy as a Node web service with a persistent disk/volume mounted at the app's `data/` directory, set the environment variables from `.env.example`, and use `npm start`. SQLite is file-backed, so an ephemeral deployment filesystem will lose order data on restart. For multiple app instances, replace SQLite with a managed database and use shared durable storage. Use HTTPS in production.

This starter does not process reservations, refunds, tax rules, delivery dispatch, or email/SMS notifications. Configure applicable tax, privacy, food-safety, and payment requirements before production use.
