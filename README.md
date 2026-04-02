# ASC System Scanner

A web-based tool that verifies whether a candidate's system meets ASC's technical requirements. The user downloads a lightweight script that collects system information, then the page runs an internet speed test and displays a pass/fail report that can be emailed to HR. Supports both Windows and macOS.

---

## Project Structure

```
system_checker/
├── index.html          # HTML structure
├── css/
│   └── styles.css      # All styling
├── js/
│   └── app.js          # All logic (eligibility, speed test, email)
├── assets/
│   └── ASC_logo.jpg    # Logo
└── README.md
```

---

## How It Works

1. User visits the hosted page and clicks **Download Checker**
2. **Windows:** `ASC_Checker.bat` is downloaded (PowerShell encoded as Base64 inside a batch file) — double-click to run
   **macOS:** `ASC_Checker.sh` is downloaded — run via `bash ~/Downloads/ASC_Checker.sh` in Terminal
3. The script silently collects system data and reopens the page with results as URL parameters
4. User enters their name and email, then clicks **Run Speed Test**
5. The page runs a download/upload speed test via Cloudflare
6. Results are displayed with green (eligible) / red (not eligible) indicators
7. HR receives the report via the **Send Report to HR** button

---

## Requirements Checked

| Check                | Minimum / Requirement                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| Download Speed       | ≥ 100 Mbps                                                                            |
| Upload Speed         | ≥ 10 Mbps                                                                             |
| Operating System     | Windows 11 **or** macOS Ventura (13) or newer                                         |
| RAM                  | ≥ 16 GB                                                                               |
| Free Disk Space      | ≥ 50 GB                                                                               |
| Processor (Windows)  | Intel Core i5/i7/i9 9th gen+ (no H/F suffix), AMD Ryzen 7 3700X+, min quad-core 2 GHz |
| Processor (macOS)    | Apple M1 or newer                                                                     |
| Antivirus            | Paid antivirus only (Windows Defender not eligible)                                   |

---

## Setup & Deployment

### 1. Zapier Webhook (for HR email reports)

Reports are sent via a Zapier webhook that triggers an email to HR.

1. Create a Zap at [zapier.com](https://zapier.com) with:
   - **Trigger:** Webhooks by Zapier → Catch Hook
   - **Action:** Email by Zapier (or Gmail) → Send Outbound Email
2. Map the following fields from the webhook data in the email action:

   | Zapier Field   | Maps To         | Description                        |
   | -------------- | --------------- | ---------------------------------- |
   | `to_email`     | To              | Recipient addresses (comma-separated) |
   | `subject`      | Subject         | Email subject line                 |
   | `body_text`    | Body            | Full plain-text results report     |
   | `user_email`   | Reply To        | Applicant's email address          |

   Additional fields available in the payload: `first_name`, `last_name`, `score`, `check_date`.

3. Copy the webhook URL from Zapier and paste it into `js/app.js` in the `CONFIG` object:

```js
reportEndpoint: "https://hooks.zapier.com/hooks/catch/xxxxx/xxxxx/",
```

### 2. Local Testing (VS Code)

Install the **Live Server** extension, then click **Go Live** in the VS Code status bar. The page will be served at `http://127.0.0.1:5500`.

---

## Changing Eligibility Thresholds

All thresholds are defined at the top of `js/app.js` in the `CONFIG` object:

```js
const CONFIG = {
  thresholds: {
    downloadMbps : 100,
    uploadMbps   :  10,
    ramGB        :  16,
    diskFreeGB   :  50,
    cpuCores     :   2,
    cpuGHz       :   2.0,
  },
  requiredOS: 'Windows 11',
  ...
};
```
