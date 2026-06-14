---
name: project-pos-hdmi-ip-stream
description: "פרויקט חיבור מסך POS לרשת IP — הצגת המסך כמצלמת אבטחה ב-NVR דרך ממיר HDMI-to-IP. כולל ממצאי מחקר מלאים, פקודות PowerShell, ותרחישי תקלה."
metadata: 
  node_type: memory
  type: project
  originSessionId: 025d930d-452c-4daf-9609-07d8a8931e3d
---

# פרויקט: הזרמת מסך קופת POS לרשת IP כמצלמת אבטחה

## מטרה
חיבור מסך קופת POS לרשת IP באמצעות ממיר HDMI-to-IP, והצגת תמונת המסך כחלק ממערכת מצלמות האבטחה ב-NVR.

**Why:** לצפייה בפעילות הקופה דרך מערכת הריגול הקיימת, ללא התקנת מצלמה נוספת.
**How to apply:** לפתוח זיכרון זה בתחילת כל שיחה הקשורה לפרויקט לפני כל פעולה.

---

## טופולוגיית חיבור — סופית ✅
```
POS Windows 10 Pro (DisplayPort out)
    ↓
DP-to-HDMI adapter
    ↓
AVMATRIX SE1217 [HDMI In]
    ├→ [HDMI Loop-Out] → מסך קופה (אופציונלי)
    └→ [LAN RJ-45] → Switch/Router
                          ↓
              Provision-ISR NVR12-32800FAN(1U)
                  (via RTSP: rtsp://[SE1217-IP]:554/hdmi)
                  (או ONVIF auto-discovery)
```

**יתרון מרכזי:** SE1217 כולל HDMI Loop-Out — אין צורך ב-splitter נוסף!
ניתן לחבר גם מסך רגיל לקופה וגם לשדר לרשת בו-זמנית.

---

## פרטי מכשירים

### קופת POS — P2C G-250P ✅ מזוהה
- **יצרן**: P2C / IC System — Made in Korea
- **דגם**: G-250P (POS System)
- **מעבד**: Intel® Celeron® Quad-core J4125 (Jasper Lake, Intel UHD Graphics 600)
  - חלופה: 7th/8th Gen Intel Core i3/i5/i7 (לפי קונפיגורציה)
- **זיכרון**: DDR4, עד 32GB (בסיס 4GB)
- **אחסון**: 2.5" SATA III SSD עד 512GB
- **מסך מובנה**: 15" True-Flat Capacitive 10-Point Multi-touch, 1024×768, 350 cd/m²
- **מערכת הפעלה**: Windows 10 Pro (המשתמש ציין)
- **חשמל**: DC+12V/5A
- **S/N**: PS14C22103006
- **יציאת וידאו חיצונית**: DisplayPort (DP) ✅
- **תמיכת Multi-Monitor**: עד 3 מסכים עצמאיים ✅ (HDMI, DVI, DisplayPort, VGA)

**חשוב:** למחשב יש מסך מובנה 15" + יציאת DP חיצונית
→ המסך המובנה משמש את הקופאי
→ יציאת DP → DP-to-HDMI → SE1217 → NVR (מראה/שכפול תמונה)

### ממיר HDMI-to-IP — AVMATRIX SE1217 ✅ מזוהה
- **יצרן**: AVMATRIX
- **דגם**: SE1217 H.265/H.264 HDMI Streaming Encoder
- **כניסות**: 1× HDMI In, 1× Audio 3.5mm
- **יציאות**: 1× **HDMI Loop-Out** ✅ (אפשר לחבר גם מסך רגיל!)
- **רשת**: RJ-45 100/1000Mbps
- **חיבור ממשק**: `http://192.168.1.168` (ברירת מחדל)
- **משתמש/סיסמה**: `admin` / `admin`
- **תמיכת DHCP**: כן (יכול לקבל IP מהראוטר)
- **IP ברירת מחדל**: `192.168.1.168`, Subnet: `255.255.255.0`, GW: `192.168.1.1`
- **פרוטוקולים**: RTSP, RTMP, HTTP, RTP, UDP, Multicast, Unicast, SRT
- **ONVIF**: ✅ תמיכה מלאה (User: admin, Password: admin, Device Name: hd-Encoder)
- **Video Coding**: H.265/H.264
- **Max Resolution**: 1920×1080 @ 60fps
- **Bitrate**: 16Kbps–12Mbps
- **צריכת חשמל**: 5W, DC 12V/2A
- **RTSP URL ראשי**: `rtsp://[IP]:554/hdmi`
- **RTSP URL משני**: `rtsp://[IP]:554/hdmi_ext`
- **HTTP URL**: `http://[IP]:80/hdmi`
- **Reboot Timer**: ניתן לקבוע restart אוטומטי כל X שעות (0-200) — שימושי ל-24/7
- **Reset**: לחיצה ארוכה 5 שניות על כפתור RESET

### NVR — Provision-ISR NVR12-32800FAN(1U) ✅ מזוהה
- **יצרן**: Provision-ISR (חברה ישראלית)
- **דגם**: NVR12-32800FAN(1U) — 1U Rack, 32 ערוצים
- **אחסון**: 2x SATA bays (max 10TB כל אחד, סה"כ 20TB), מגיע עם 2TB
- **ערוצים**: 32 ערוצי IP
- **רזולוציה מקסימלית**: 12MP (4000×3000)
- **יציאות וידאו**: 2x HDMI (4K+FHD) + VGA
- **ONVIF**: תומך ONVIF Profile T + Profile G (גרסה 20.12) ✅
- **RTSP**: תמיכה מלאה ✅
- **פורמט RTSP לגישה ל-NVR עצמו**:
  - Main stream: `rtsp://<NVR-IP>:554/ch<מספר-ערוץ>/main/av_stream`
  - Sub stream: `rtsp://<NVR-IP>:554/ch<מספר-ערוץ>/sub/av_stream`
- **אתר יצרן**: provision-isr.com
- **תמיכה**: ניתן לפנות לתמיכה ישראלית
- **PDF רשמי**: https://provision-isr.com/wp-content/uploads/generatepdf/NVR12-32800FAN(1U).pdf

### אביזרים זמינים
- ✅ מתאם DP to HDMI
- ✅ כבלים

---

## גישה מרחוק לרשת החנות

### מצב נוכחי
- לא ברור אם יש VPN או כלי גישה מרחוק מותקן בחנות
- **לבדוק עם המשתמש**: AnyDesk / TeamViewer / Chrome Remote Desktop / RDP

### זרימת העבודה עם גישה מרחוק
1. פתיחת דפדפן (Playwright)
2. כניסה לכלי גישה מרחוק (Chrome Remote Desktop מועדף — browser-based)
3. המשתמש מאשר חיבור בחנות
4. גישה לממשק הממיר ול-NVR דרך הרשת המקומית של החנות

---

## ממצאי מחקר — HDMI-to-IP Encoder

### עקרון הפעולה
ממיר HDMI-to-IP לוקח אות וידאו מ-HDMI (מקלדת, תמונה) וממיר אותו לזרם רשת IP.
פרוטוקולים נפוצים: **RTSP**, **ONVIF**, HTTP-FLV, HLS.

### תהליך הגדרה סטנדרטי (4 שלבים)
```
שלב 1: חיבור רשת
  - ממיר מחובר לרשת ב-Ethernet (אותה subnet כמו NVR)
  - HDMI מ-POS מחובר ל-HDMI In של הממיר

שלב 2: גישה לממשק ואיתור RTSP URL
  - מציאת IP של הממיר: ראות/DHCP של הראוטר
  - גישה ל-http://[IP] בדפדפן
  - אישורים ברירת מחדל: admin/admin  או  admin/0000
  - ניווט לStream Settings
  - RTSP URL לדוגמה: rtsp://[IP]:554/stream1

שלב 3: בדיקה ב-VLC לפני הוספה ל-NVR
  - פתח VLC → Media → Open Network Stream
  - הדבק את RTSP URL → לחץ Play
  - אם התמונה עולה — הממיר מוכן

שלב 4: הוספה ל-NVR
  - Camera Management → Add → Manual Add
  - פרוטוקול: ONVIF (עדיף) או RTSP
  - IP + Port 554 + Username + Password
  - Apply/Save
```

### ONVIF vs RTSP ב-NVR
| | ONVIF | RTSP ידני |
|---|---|---|
| גילוי אוטומטי | כן | לא |
| תאימות | NVR חייב לתמוך | כמעט כל NVR |
| קונפיגורציה | פשוטה יותר | דורש URL מדויק |
| **המלצה** | נסה ONVIF ראשון | גיבוי אם ONVIF נכשל |

### דגמים נפוצים בשוק
| יצרן | דגמים | מאפיין מיוחד |
|---|---|---|
| **Kiloview** | N2, E1, E2 | ONVIF, loop-out בחלק מהדגמים |
| **Magewell** | Pro Convert HDMI to NDI | איכות גבוהה, יקר |
| **Lenkeng** | LKV383 | תקציבי, RTSP |
| **AVMATRIX** | SE1217 | loop-out, RTSP+ONVIF |
| **BZB Gear** | BG-STREAM-E | ONVIF, web UI נוח |
| **CCTV Camera World** | HDMIP | PoE, ONVIF, תוכנן לNVR |

---

## ממצאי מחקר — Windows 10 Pro: Power Management

### גורמי ניתוק תמונה — Windows

#### 1. Monitor Timeout (הנפוץ ביותר)
Windows מכבה את אות המסך לאחר X דקות. הממיר מאבד אות → NVR מציג offline.

**פתרון מלא (PowerShell, כמנהל):**
```powershell
# כיבוי timeout כשהמחשב פועל ומחובר לחשמל:
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

# כיבוי timeout גם כשהמסך נעול:
powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 0
powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOCONLOCK 0
powercfg.exe /setactive SCHEME_CURRENT
```

> **הערה חשובה:** Windows מכבה מסך לאחר **60 שניות** כאשר המחשב נעול — זה התנהגות by-design שאינה ניתן לשינוי מה-UI הרגיל. הפקודה VIDEOCONLOCK מתקנת זאת.

#### 2. Windows Update Reboot
Windows Update יכול להפעיל מחדש את המחשב בשעות הלילה.

**פתרון:**
```powershell
# עיכוב עדכונים אוטומטיים (Group Policy):
# gpedit.msc → Computer Configuration → Administrative Templates
# → Windows Components → Windows Update
# → "Configure Automatic Updates" → Disabled/Notify only
```

#### 3. Sleep / Hibernate
```powershell
# כיבוי hibernate לחלוטין:
powercfg /h off
# בחירת High Performance power plan:
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c
```

#### 4. Screen Saver
- Settings → Personalization → Lock Screen → Screen Saver → None

---

## ממצאי מחקר — HDCP ו-DisplayPort

### מה זה HDCP?
High-bandwidth Digital Content Protection — הצפנת אות וידאו למניעת פיראטיות.
בעברית: "נעילה" של אות HDMI/DP שמונעת מכשירים לא-מאושרים לצלם את התמונה.

### האם HDCP מפריע לממיר HDMI-to-IP?

**תשובה: כנראה שלא, לPOS.**

| תוכן | HDCP? | השפעה על ממיר |
|---|---|---|
| Windows Desktop רגיל | **לא** | ✅ ממיר יעבוד |
| תוכנת POS (רשת, קופה) | **לא** | ✅ ממיר יעבוד |
| Netflix/DRM Video | **כן** | ❌ ממיר יחסם |
| BluRay Playback | **כן** | ❌ ממיר יחסם |

**מסקנה:** POS שמריץ תוכנת קופה — לא יהיה HDCP. **זה לא בעיה.**

### DisplayPort Content Protection (DPCP)
DPCP הוא המקבילה של HDCP עבור DisplayPort — אותו עיקרון, אותה מסקנה.

---

## ממצאי מחקר — DisplayPort Splitting ו-Loop-Out

### הבעיה
POS עם יציאת DP אחת בלבד — כיצד לחבר גם מסך רגיל וגם ממיר?

### פתרון 1: HDMI Encoder עם Loop-Out ✅ (עדיף)
חלק מהממירים (למשל AVMATRIX, Kiloview E2) כוללים יציאת HDMI loop-out:
```
POS (DP) → DP-to-HDMI → ממיר [HDMI In]
                           ממיר [HDMI Loop-Out] → מסך רגיל
                           ממיר [IP Stream] → רשת → NVR
```
**לבדוק בהוראות הממיר שנרכש: האם יש HDMI Loop-Out?** ⏳

### פתרון 2: HDMI Splitter (1-to-2) אחרי DP-to-HDMI
```
POS (DP) → DP-to-HDMI adapter → HDMI Splitter 1-to-2
                                      → מסך רגיל
                                      → ממיר HDMI-to-IP
```
**יתרון:** פשוט, זול (~50-100 ש"ח)
**חיסרון:** ה-Splitter צריך להיות **Active** (לא פסיבי), ותומך בRezolution הנדרשת

### פתרון 3: DisplayPort MST Hub
DP MST Hub מאפשר חיבור מספר מסכים ליציאת DP אחת (Multi-Stream Transport).
**בעיה:** ממירי HDMI-to-IP לא תמיד מוכרים כ-MST display → עלול לא לעבוד.

### פתרון 4: Headless Display Emulator (Dummy Plug)
אם הממיר לא מדמה EDID כמו מסך — Windows לא ישלח אות.
**פתרון:** DP Dummy Plug → מרמה את Windows לחשוב שמסך מחובר.
- מחיר: 20-50 ש"ח
- דרושים רק אם ה-POS לא שולח אות גם עם הממיר מחובר

---

## תוכנית פעולה — ספציפית למכשירים שלנו ✅

### שלב 0 — עדיין ממתינים (לפני שמתחילים)
```
[ ] בדוק: מה כלי הגישה מרחוק לחנות? (AnyDesk / TeamViewer / Chrome Remote Desktop)
[ ] בדוק: מה ה-IP range של הרשת בחנות? (לרוב 192.168.1.x)
[ ] בדוק: תמונת מחשב POS (מפרט חומרה)
```

---

### שלב 1 — חיבור פיזי (המשתמש עושה ידנית)
```
POS DP out → DP-to-HDMI adapter → SE1217 [HDMI IN]
SE1217 [HDMI LOOP OUT] → מסך קופה רגיל (אם רוצים)
SE1217 [LAN] → כבל Ethernet → Switch/Router של החנות
SE1217 [DC 12V] → חשמל
```
✅ אין צורך ב-splitter — Loop-Out מטפל בכך

---

### שלב 2 — גישה לממשק SE1217 (אנחנו עושים ביחד)
```
1. חיבור מרחוק לרשת החנות (נסכים על כלי)
2. פתיחת דפדפן → http://192.168.1.168 (ברירת מחדל)
   OR: בדיקה ב-DHCP list של הראוטר מה IP קיבל
3. כניסה: admin / admin
4. בדיקה: Device Status → האם יש תמונה מה-POS?
```

---

### שלב 3 — הגדרות SE1217 לחיבור עם Provision-ISR NVR
```
באתר הממשק של SE1217:

א. Network Settings:
   - DHCP: Enable (המתן לראות IP שקיבל)
   - או Static IP שמתאים לרשת (למשל 192.168.1.200)

ב. Main Stream Settings → MAIN PARAMETER:
   - Stream Protocol: H.264
   - Encoding Frame Rate: 25
   - Bitrate Control: VBR
   - MaxBitrate: 4000-6000 (מספיק לקופה, לא יעמיס על הרשת)
   - לחץ Apply

ג. Main Stream Settings → RTSP:
   - RTSP: Enable
   - RTSP Path: /hdmi
   - RTSP Port: 554
   - RTSP Authentication: Disable (עדיף לתחילה)
   - RTSP Content: Video & Audio
   - RTSP TCP: UDP
   - לחץ Apply

ד. Audio and Extension → ONVIF Settings:
   - ONVIF Auth: Enable
   - ONVIF User: admin
   - ONVIF Password: admin
   - ONVIF Device Name: POS-Camera (שם מזהה)
   - לחץ Apply

ה. System Settings → Reboot Timer:
   - הגדר: 24 שעות (יציבות 24/7)
   - לחץ Apply
```

---

### שלב 4 — בדיקה לפני חיבור ל-NVR (VLC)
```
1. הורד VLC על כל מחשב ברשת החנות
2. VLC → Media → Open Network Stream
3. הזן: rtsp://[SE1217-IP]:554/hdmi
4. לחץ Play
5. אם התמונה עולה → ✅ SE1217 עובד!
6. אם שחור → בדוק: האם POS שולח אות DP?
```

---

### שלב 5 — הוספה ל-Provision-ISR NVR
```
אפשרות א: ONVIF (עדיף — אוטומטי)
  1. NVR → Camera Management → Add Camera
  2. בחר: Auto Search / ONVIF
  3. NVR יאתר את SE1217 (Device Name: POS-Camera)
  4. הזן credentials: admin / admin
  5. שמור

אפשרות ב: RTSP ידני (גיבוי אם ONVIF נכשל)
  1. NVR → Camera Management → Add Camera → Manual
  2. Protocol: Generic RTSP (או Third-Party)
  3. IP: [SE1217-IP]
  4. Port: 554
  5. Channel URL: /hdmi
  6. Username: admin, Password: admin
  7. שמור
```

---

### שלב 6 — הגדרות Windows 10 Pro (ב-POS)
```powershell
# הרץ PowerShell כמנהל (Admin) ב-POS:

# מניעת כיבוי מסך:
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

# מניעת כיבוי מסך גם כשהמסך נעול:
powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 0
powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOCONLOCK 0
powercfg.exe /setactive SCHEME_CURRENT

# כיבוי hibernate:
powercfg /h off

# High Performance power plan:
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c
```
כיבוי Screen Saver: Settings → Personalization → Lock Screen → Screen Saver → None

---

### תרחיש A — שגיאה: NVR לא מזהה SE1217 ב-ONVIF
```
בדוק:
1. SE1217 ו-NVR באותה Subnet? (192.168.1.x)
2. ONVIF Auth מופעל ב-SE1217?
3. נסה ONVIF Device Manager (כלי חינמי) — מאתר devices ברשת
4. אם ONVIF לא עובד → עבור לאפשרות ב (RTSP ידני)
```

---

### תרחיש B — שגיאה: תמונה שחורה ב-VLC / NVR
```
בדוק:
1. SE1217 → Device Status: האם Video Resolution מציג רזולוציה?
   → אם לא: בעיה עם חיבור HDMI ל-POS
2. האם POS שולח אות DP?
   → בדוק: Windows + P → Duplicate/Extend
3. האם DP-to-HDMI adapter עובד?
   → נסה לחבר לטלוויזיה רגילה לפני SE1217
4. HDCP: POS אמור לא לשדר HDCP (תוכנת קופה = OK)
```

---

### תרחיש C — שגיאה: תמונה נפסקת לאחר זמן
```
סיבה 1: Windows כיבה מסך (Power Management)
→ הרץ PowerShell commands משלב 6

סיבה 2: SE1217 Reboot Timer לא הוגדר
→ System Settings → Reboot Timer → 24

סיבה 3: רשת (ירידה ב-Wi-Fi / Switch)
→ ודא SE1217 מחובר ב-Ethernet (לא Wi-Fi)

סיבה 4: Windows Update הפעיל מחדש
→ Settings → Update & Security → Advanced → Pause Updates
→ Active Hours: שעות עבודת החנות
```

---

### תרחיש D — שגיאה: DP-to-HDMI לא עובד עם SE1217
```
הסבר: SE1217 צריך שהמקור יזהה אותו כ"מסך" (EDID handshake)
פתרון: DP EDID Emulator (Dummy Plug) — 20-50 ש"ח
→ מחבר ל-DP port של POS ומרמה אותו שמסך מחובר
→ אפשר גם: DP-to-HDMI active adapter עם EDID emulation מובנה
```

---

### תרחיש 4 — ❌ תמונה נפסקת לאחר זמן
```
בדיקה מהירה: מה נפסק? NVR מציג offline, או הממיר עצמו אובד אות?

אם Windows כיבה מסך:
  → הפעל PowerShell Power fixes (ראה ממצאי מחקר)
  → כבה screen saver
  → כבה hibernate

אם הממיר מאבד IP (DHCP lease):
  → הגדר IP סטטי לממיר

אם EDID negotiation נכשל:
  → רכש DP Dummy Plug
```

---

### תרחיש 5 — ❌ POS לא שולח אות ל-DP כלל
```
גורם: Windows לא "רואה" מסך → לא שולח אות DP
פתרון: DisplayPort Dummy Plug (DP Emulator)
  → מרמה את Windows לחשוב שמסך מחובר
  → DP → Dummy Plug (עבור Windows לראות מסך)
  → DP Splitter → ממיר + מסך אמיתי
```

---

### תרחיש 6 — ❌ ניתוק אחרי כמה שעות (ספציפי)
```
בדיקת גורמים:
1. Event Viewer → Windows Logs → System → מה קרה בשעה שנפסק?
2. בדוק אם Windows Update הפעיל restart
3. בדוק אם NVR הוא שניתק (ולא הממיר)
4. הגדר Task Scheduler לשלוח ping לממיר כל שעה ולכתוב לוג
```

---

## סקריפטים מוכנים לשימוש

### הגדרת Power Management ב-Windows 10 (הפעל כמנהל)
```powershell
# מניעת כל ניתוק מסך:
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /h off
powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOIDLE 0
powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_VIDEO VIDEOCONLOCK 0
powercfg.exe /setactive SCHEME_CURRENT
# הגדרת High Performance:
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c
Write-Host "Power settings applied. Display will never turn off."
```

### בדיקת RTSP עם PowerShell (אם VLC זמין)
```powershell
# פתח VLC עם RTSP URL (החלף IP):
$rtspUrl = "rtsp://192.168.1.100:554/stream1"
Start-Process "C:\Program Files\VideoLAN\VLC\vlc.exe" -ArgumentList $rtspUrl
```

### איתור IP של הממיר ברשת
```powershell
# סריקת ה-subnet לאיתור מכשירים חדשים:
1..254 | ForEach-Object {
    $ip = "192.168.1.$_"
    if (Test-Connection -ComputerName $ip -Count 1 -Quiet -ErrorAction SilentlyContinue) {
        Write-Host "$ip — Online"
    }
}
```

---

## שאלות פתוחות (ממתין לקבל מהמשתמש)

| שאלה | סטטוס |
|---|---|
| מה דגם הממיר HDMI-to-IP? | ⏳ ממתין לקובץ הוראות |
| יש HDMI Loop-Out לממיר? | ⏳ לבדוק בהוראות |
| מה דגם/יצרן ה-NVR? | ⏳ לא ידוע |
| מה מפרט מחשב ה-POS? | ⏳ ממתין לתמונה |
| מה כלי הגישה מרחוק לחנות? | ⏳ לא ידוע |
| מה ה-IP range של רשת החנות? | ⏳ לא ידוע |

---

## מצב כללי
- שלב: **מחקר הושלם — ממתין לפרטים לפני יישום**
- ❌ לא להתחיל שום שלב ביישום עד שהמשתמש שולח הוראות הממיר + תמונת POS
- תאריך עדכון: 2026-06-08
