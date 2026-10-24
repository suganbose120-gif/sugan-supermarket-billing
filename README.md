# Sugan Supermarket Billing System

A locally hosted point of sale application for Sugan Supermarket. The React/Vite interface talks to a local Express API. The backend uses SQLite (via sql.js) and stores the database at `data/sugan-supermarket.sqlite`; the database remains on this computer between restarts.

## Requirements

- Windows 10/11 (also works on other Node.js platforms)
- Node.js 20 or newer and npm
- Internet access for the initial `npm install`; after dependencies are installed, the application runs locally without an internet connection

## Install and run

From this project folder:

```powershell
npm install
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`). The API listens only on this computer at `http://127.0.0.1:4318`.

Create and serve the production build locally:

```powershell
npm run build
npm start
```

Then open `http://127.0.0.1:4318`. `npm start` serves the built frontend and API together. Run `npm run build` again after changing frontend code. The first run applies the versioned SQLite schema migration and inserts default settings. No sample products or sales are inserted into the real database.

Set `DATA_DIR` to move the database folder, or `PORT` to change the API port. Copy `.env.example` as a reference; Node does not load `.env` automatically, so set these variables in the Windows environment before starting the app. For example:

```powershell
$env:DATA_DIR = 'D:\SuganData'
$env:PORT = '4318'
npm start
```

## Barcode scanner

Most USB barcode guns behave like a keyboard. Connect the scanner, open **New bill**, and scan a registered barcode. The cashier field is focused when the screen opens and after each item. The scanned characters are looked up when the scanner sends Enter. A repeat scan increases that item's quantity. The field also accepts manual barcode, product name, and SKU searches. If a barcode is not found, the app offers to register a new product using that barcode.

If your scanner supports suffix configuration, set its suffix/postamble to **Enter** (sometimes labelled CR, Return, or Carriage Return). Use the scanner manufacturer's setup sheet or configuration barcodes for this option. No special scanner driver or SDK is needed. F2 starts a new bill and focuses the scanner field; if the current bill has items, the app asks before discarding them. Escape clears the scanner field. A normal keyboard can enter barcodes manually.

## UPI bill QR

Checkout creates a new QR locally for the current bill total using payee **Sugan Bose** (`suganbose120@okicici`), currency INR, a unique bill reference, and the `mam=Y` URI field. The QR refreshes when the total changes. The attached static QR is copied to `public/upi-qr.png` as a reference and can be moved by setting `VITE_UPI_QR_ASSET` (for Vite, set it in a `.env` file). It is only shown in Settings; checkout never uses it as the payment QR.

UPI apps differ: some may allow a payer to edit an amount even when the URI includes `mam=Y`. Before completing a UPI sale, the cashier must check the exact credit in the merchant UPI app and confirm that check in the POS. The database records this as a cashier assertion, not provider verification. This app does not receive payment status or transaction callbacks. A compatible dynamic QR/payment provider, merchant credentials, and verified payment callback/reconciliation integration are required for automatic verification and an amount restriction enforced by the payment provider.

## Thermal receipt printers

After a successful sale, the app opens the browser/Windows print dialog when pop-ups are allowed; an in-app receipt preview remains available to print later. It supports configured 80 mm and 58 mm layouts. Connect and install the printer in Windows, then select it in the print dialog. In printer preferences, select the matching paper width and disable browser headers/footers if they appear. Use the print dialog's preview to confirm margins and scaling for your printer before serving customers.

This app does not implement direct ESC/POS printing. It prints through the browser's normal Windows printer support, so it can also use other Windows printers.

## Products CSV

Import and export CSV from **Products**. The import expects a header row. Optional columns may be left blank. Monetary prices are in rupees and quantities may have up to three decimal places. Duplicate barcode or SKU rows are reported and skipped while other valid rows import.

```csv
name,barcode,sku,category,purchase_price,selling_price,stock,low_stock,unit,expiry_date,gst_rate,hsn_code
Rice 1 kg,8901234567890,RICE-1KG,Grocery,72.00,85.00,24,5,packet,,5,
Milk 500 ml,8901234567891,MILK-500,Dairy,25.00,30.00,18,4,packet,2026-10-28,5,
Loose sugar,,SUGAR-LOOSE,Grocery,42.00,50.00,35.5,5,kg,,0,
```

A copy of this template is included at [`sample-products.csv`](./sample-products.csv).

`hsn_code` is optional for billing but is required to map a taxable product into Tally. Enter the correct classification supplied by your accountant; the application does not infer HSN/SAC codes or GST rates.

## Sales, inventory, and reports

The checkout saves a sale only after **Complete sale** is pressed and payment requirements are satisfied. Sale creation, item snapshots, stock reductions, and stock movement rows are wrapped in a SQLite transaction. Cash and UPI are supported; only cash accepts the received amount and calculates change. The API rejects new Card sales; the database retains its old Card value only to keep historical bills readable. UPI requires a manual cashier assertion after checking the merchant app; it is not provider-verified. A request key prevents a retried request from creating a second bill. Cancelled/abandoned bills do not affect stock.

Product prices are stored as integer paise. Stock is stored to three decimal places. Product barcodes and SKUs are unique. Stock cannot go negative unless the setting is enabled. Stock restocks and adjustments are recorded under **Inventory**; completed bills create sale movements. Product deletion removes it from active use while preserving past bill snapshots.

Reports use completed sales and stored sale item snapshots. Gross profit is estimated from sale and purchase prices, less line discounts; it does not include overhead, shrinkage, or other operating costs.

## TallyPrime XML integration

The **Tally Integration** page uses the local TallyPrime XML/HTTP service. The backend accepts only loopback Tally endpoints; it does not expose a raw XML proxy. The default is `http://127.0.0.1:9000`, and `TALLY_TIMEOUT_MS` defaults to 8000 ms. The connection test POSTs valid XML, parses Tally's response, and compares the loaded company to `TALLY_EXPECTED_COMPANY` (default `Sugan Super Market`). TallyPrime supports XML over HTTP on its configured server port, normally 9000 ([TallyPrime XML integration](https://help.tallysolutions.com/xml-integration/), [official XML samples and import responses](https://help.tallysolutions.com/sample-xml/)).

Run the Express billing backend on the **same Windows computer as Tally**. The backend sends the XML request, so `localhost` always means the machine running Node.js, not the browser computer. If this application is ever hosted remotely, the default loopback URL will point to that remote host and cannot reach Tally on the cashier's PC. Move/run the backend beside Tally for the supported setup. This build rejects non-loopback Tally URLs; do not expose Tally port 9000 to a network. A remote deployment requires a separately secured, authenticated private tunnel/bridge and an intentional server-side integration change.

To enable the local XML server, open TallyPrime and load the intended company. Open **F1 (Help) → Settings → Advanced Configuration**, enable the HTTP Server, and use port `9000`. Confirm TallyPrime reports that the server is running. See Tally’s [XML integration setup](https://help.tallysolutions.com/xml-integration/). Keep the service local to this computer and do not open port 9000 to the network.

Set backend variables in the same PowerShell window before starting the application. Node does not automatically read `.env`; `.env.example` lists the supported values:

```powershell
$env:TALLY_XML_URL = 'http://127.0.0.1:9000'
$env:TALLY_EXPECTED_COMPANY = 'Sugan Super Market'
$env:TALLY_TIMEOUT_MS = '8000'
$env:TALLY_SYNC_INTERVAL_MS = '15000'
$env:TALLY_ADMIN_TOKEN = [guid]::NewGuid().ToString('N')
npm run dev
```

Keep the generated administrator token for that running session. Tally settings, adoption, retries, and write operations require it. The app starts with live synchronization **disabled**. A successful connection test proves only that Tally answered a read-only XML request; it does not prove that a master or voucher import will be accepted.

### Safe Tally setup and test sequence

1. Make a database backup from **Settings & backup**. Create a separate test company in Tally and use a separate POS database copy for the test; set `DATA_DIR` to that copy so test bills and stock changes cannot affect the live billing database.
2. In **Tally Integration**, test the connection, enter the exact loaded test-company name, enter the company state and GST effective date only when applicable, map existing Tally ledgers, stock group, and units, save, and verify the loaded company. Use your accountant’s confirmed tax configuration and HSN/SAC classifications.
3. Run the product dry-run. Explicitly adopt any matching existing Tally item. Queue one test product and enable synchronization only for the isolated test company/database. Product creation does not set or overwrite opening quantities, rates, or balances.
4. Confirm the test item exists in Tally. Create one sample cash bill in the isolated POS database. Preview its generated voucher; then queue it and confirm Tally’s import statistics and the voucher’s amount, tax, payment ledger, inventory movement, and bill reference in the test company.
5. The outbox marks a record synchronized only when Tally reports the expected created/altered count. If a response is lost, sales retries look up the stable bill reference before another import. A product import with an unknown outcome requires a manual Tally check before retrying.
6. After successful testing, leave live synchronization disabled. Back up the test company and test database as needed. In the production POS database, verify the production company and its ledger/unit/tax mappings again before deliberately enabling live synchronization.

Only completed saved sales are queued; draft bills do not exist in the database. Each completed bill, item snapshot, local stock reduction, stock movement, and outbox job is committed in one SQLite transaction. Each sale voucher contains one inventory allocation, so Tally deducts stock once from that voucher while this app independently updates its own stock once at checkout. Opening balances are never sent. Purchases, returns, cancellations, and manual adjustments remain local; two-way or purchase/return sync is not implemented. Configure existing Tally stock balances separately before sales if your Tally company disallows negative stock.

The application has no customer or place-of-supply field in its billing workflow. The selected GST posting strategy is a single administrator-reviewed policy for these walk-in bills (single output ledger, intra-state CGST+SGST/UTGST, or inter-state IGST). Do not use it for sales requiring different place-of-supply treatment until that information is captured and verified per transaction. TallyPrime's inventory settings, voucher type, godown/batch configuration, and GST setup can affect import acceptance; voucher behavior must be confirmed in the disposable test company.

The Tally dashboard separates local billing totals/tax from data returned by Tally. Trial Balance values are closing balances, not sales turnover; the app does not subtract unrelated accounts and label the result as a sales reconciliation. A failed import is not marked synced, and no Tally voucher is deleted or altered automatically.

## Backup and restore

Under **Settings & backup**, choose **Download SQLite backup** to save a copy of the local database. Keep copies on a separate drive or other safe location. To restore, choose **Restore a backup file** and confirm. The backup replaces the current database immediately. The restore endpoint validates SQLite integrity and required tables before replacing the file. This is destructive to data added after that backup; make a backup of the current database first if you may need it.

## Data and privacy

The app binds to loopback (`127.0.0.1`) and does not transmit sales or product data to a remote service. Database writes are saved locally after changes. Keep the Windows account and backup files secure. The project currently has no cashier login or role-based authorization; use the computer's Windows account controls to limit access to settings and stock adjustments.

