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

### 1. EmailJS (for HR email reports)

1. Create a free account at [emailjs.com](https://www.emailjs.com)
2. Add an **Email Service** using Gmail / Google Workspace
3. Create an **Email Template** — available template variables:

   | Variable                                                             | Description                   |
   | -------------------------------------------------------------------- | ----------------------------- |
   | `{{first_name}}` / `{{last_name}}`                                   | Applicant name                |
   | `{{user_email}}`                                                     | Applicant email               |
   | `{{score}}`                                                          | e.g. `6 / 7`                  |
   | `{{check_date}}`                                                     | Date and time of check        |
   | `{{summary}}`                                                        | Full plain-text results block |
   | `{{download_speed}}` / `{{upload_speed}}`                            | Speed test results            |
   | `{{os}}` / `{{cpu}}` / `{{ram}}` / `{{disk_free}}` / `{{antivirus}}` | Individual system fields      |

4. Open `js/app.js` and fill in the `CONFIG.emailjs` block at the top:

```js
emailjs: {
  publicKey  : 'your_public_key',
  serviceId  : 'service_xxxxxxx',
  templateId : 'template_xxxxxxx',
  hrEmail    : 'hr@yourcompany.com',
},
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
