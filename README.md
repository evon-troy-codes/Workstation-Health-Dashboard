# ASC System Scanner

A web-based tool that verifies whether a candidate's system meets ASC's technical requirements. The user downloads a lightweight script that collects system information, then the page runs an internet speed test and displays a pass/fail report. A styled HTML report is automatically emailed to HR via EmailJS. Supports both Windows and macOS.

---

## How It Works

1. User visits the hosted page and clicks **Download Checker**
2. **Windows:** `ASC_Checker.bat` is downloaded (PowerShell encoded as Base64 inside a batch file) — double-click to run
   **macOS:** `ASC_Checker.command` is downloaded — double-click to run (may need to allow in System Settings > Privacy & Security)
3. The script silently collects system data (CPU, RAM, OS, disk space, antivirus, USB headset) and reopens the page with results as URL parameters
4. User enters their name and email, then clicks **Run Speed Test**
5. The page runs a download/upload speed test via Cloudflare
6. Results are displayed with green (eligible) / red (not eligible) indicators
7. A styled report is automatically emailed to HR

---

## Requirements Checked

| Check                | Minimum / Requirement                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| Download Speed       | ≥ 100 Mbps                                                                            |
| Upload Speed         | ≥ 10 Mbps                                                                             |
| Operating System     | Windows 11 **or** macOS Ventura (13) or newer                                         |
| RAM                  | ≥ 16 GB                                                                               |
| Free Disk Space      | ≥ 50 GB                                                                               |
| Processor (Windows)  | Intel Core i5/i7/i9 9th gen+ (H/F/V/HX suffix), AMD Ryzen 7 3700X+, min quad-core 2 GHz |
| Processor (macOS)    | Apple M1 or newer                                                                     |
| Antivirus            | Paid antivirus only                                                                   |
| USB Headset          | USB headset with microphone detected                                                  |

---

## Project Structure

```
ASC-System-Scanner/
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

## Changing Eligibility Thresholds

All thresholds are defined at the top of `js/app.js` in the `CONFIG` object:

```js
const CONFIG = {
  thresholds: {
    downloadMbps : 100,
    uploadMbps   :  10,
    ramGB        :  14,
    ramGBAmd     :  10,
    diskFreeGB   :  50,
    cpuCores     :   4,
    cpuGHz       :   2.0,
  },
  requiredOS: 'Windows 11',
  ...
};
```
