const DISCLAIMER_HE =
  '⚖️ הבהרה: מידע כללי בלבד, לא ייעוץ משפטי/רפואי מחייב. אמת מול חברת התעופה ורשות התעופה לפני הטיסה.';
const DISCLAIMER_EN =
  '⚖️ Note: general info only, not binding legal/medical advice. Confirm with your airline and the aviation authority before flying.';

const MEDICAL_LEGAL_SECTIONS = ['rights', 'security', 'wheelchair', 'docs'];

const SECTIONS = {
  checklist: {
    section: 'checklist',
    title_he: '✅ צ׳ק-ליסט לפני הטיסה',
    title_en: 'Pre-flight checklist',
    needs_disclaimer: false,
    body_he: '• הודע לחברת התעופה על הצורך בנגישות — לפחות 48 שעות מראש (זכות בחוק).\n• בקש אישור הטסה לכיסא ולסוללות — גם הלוך וגם חזור.\n• בקש אישור בכתב (מייל/צילום מסך), לא רק טלפוני.\n• בקש מושב מותאם מול חברת התעופה.\n• אם יש עצירת ביניים — ציין שאתה זקוק לכיסא בכל עצירה.\n• הגע לשדה לפחות 3 שעות לפני ההמראה (כיסא חשמלי).',
    body_en: '• Notify the airline you need accessibility — at least 48h ahead (a legal right).\n• Request wheelchair + battery carriage approval — both outbound and return.\n• Get written confirmation (email/screenshot), not just a phone call.\n• Request a suitable seat with the airline.\n• If there is a stopover — state you need the wheelchair at every stop.\n• Arrive at least 3h before departure (electric wheelchair).',
  },
  docs: {
    section: 'docs',
    title_he: '📋 מסמכים לארוז ביד (לא במזוודה)',
    title_en: 'Documents to carry on (not checked)',
    needs_disclaimer: true,
    disclaimer_he: DISCLAIMER_HE,
    disclaimer_en: DISCLAIMER_EN,
    body_he: '• דרכון + ויזה (אם נדרש).\n• כרטיס נכה / תעודת נכות (ורצוי תעודה בינלאומית באנגלית).\n• אישור הטסת הכיסא והסוללות — באנגלית, הלוך ושוב.\n• צילומי תווית ה-Wh של הסוללות.\n• מכתב רפואי באנגלית המפרט את מצבך.\n• רשימת תרופות + מרשמים על שמך.\n• פרטי ביטוח נסיעות שמכסה מצב קיים + נזק לכיסא.',
    body_en: '• Passport + visa (if required).\n• Disability card (an international English card is recommended).\n• Wheelchair + battery carriage approval — in English, both ways.\n• Photos of the batteries’ Wh label.\n• A medical letter in English describing your condition.\n• Medication list + prescriptions in your name.\n• Travel insurance covering pre-existing condition + wheelchair damage.',
  },
  wheelchair: {
    section: 'wheelchair',
    title_he: '🦽 הכיסא והסוללות',
    title_en: 'Wheelchair & batteries',
    needs_disclaimer: true,
    disclaimer_he: DISCLAIMER_HE,
    disclaimer_en: DISCLAIMER_EN,
    body_he: 'הכיסא שלי: Easy Carbon Fiber — חשמלי מתקפל, סיבי פחמן, ~11 ק״ג.\nסוללות: 2 ליתיום, 5.2Ah כל אחת, מאושרות טיסה.\n\n• הסוללות נוסעות איתי בקבינה (כבודת יד) — אסור בבטן המטוס.\n• עד 100Wh: מותר. 100–160Wh: דורש אישור מראש. מעל 160Wh: אסור.\n• חובה לאמת את דירוג ה-Wh על התווית — אם הצוות לא יכול לאמת, מותר לסרב. צלם את התווית!\n• הגן על המגעים (טייפ/אריזה) למניעת קצר.\n• בקש תג על הכיסא בדלפק — שיוחזר עד דלת המטוס, לא כיסא חלופי.\n• הצמד תווית עם שם, כתובת ושם נמל היעד.\n• ודא שהביטוח מכסה נזק/אובדן לכיסא.',
    body_en: 'My chair: Easy Carbon Fiber — folding electric, carbon fiber, ~11 kg.\nBatteries: 2 lithium, 5.2Ah each, flight-approved.\n\n• Batteries travel in the cabin (carry-on) — never in the hold.\n• Up to 100Wh: allowed. 100–160Wh: needs prior approval. Over 160Wh: forbidden.\n• The Wh rating must be verifiable on the label — if staff can’t verify it, they may refuse. Photograph it!\n• Protect terminals (tape/packaging) against short circuit.\n• Ask for a tag on the chair at the desk — returned to the aircraft door, not a substitute chair.\n• Attach a label with name, address, destination airport.\n• Make sure insurance covers chair damage/loss.',
  },
  rights: {
    section: 'rights',
    title_he: '🎫 הזכויות שלי בשדה',
    title_en: 'My airport rights',
    needs_disclaimer: true,
    disclaimer_he: DISCLAIMER_HE,
    disclaimer_en: DISCLAIMER_EN,
    body_he: '• אני פטור מהמתנה בתור: ביטחון, שיקוף כבודת יד, וביקורת דרכונים (הצג תעודת נכה).\n• גם מלווה אחד שלי פטור מתור יחד איתי (מלווה אחד לכל נוסע זכאי).\n• כנוסע בכיסא גלגלים — בדיקה ידנית, ללא מעבר במגנומטר.\n• אפשר לבקש ליווי של עובד שדה — פנייה לרכז הנגישות כמה ימים מראש.\n• עלייה למטוס: ראשון לעלות, אחרון לרדת.\n• ההודעה לחברת התעופה 48ש׳ מראש היא זכות, לא טובה.',
    body_en: '• I am exempt from queues: security questioning, hand-baggage screening, and border control (show disability card).\n• One companion is also queue-exempt with me (one per eligible passenger).\n• As a wheelchair user — manual screening, no metal-detector gate.\n• I can request an airport-staff escort — contact the accessibility coordinator a few days ahead.\n• Boarding: first on, last off.\n• The 48h airline notice is a right, not a favour.',
  },
  security: {
    section: 'security',
    title_he: '🏥 הצהרת CRPS לביטחון',
    title_en: 'CRPS statement for security',
    needs_disclaimer: true,
    disclaimer_he: DISCLAIMER_HE,
    disclaimer_en: DISCLAIMER_EN,
    body_he: 'נוסח להצגה (עברית):\n"יש לי CRPS — תסמונת כאב מורכבת. רגל שמאל שלי רגישה ביותר ואסור לגעת בה. מגע עלול לגרום לי להתעלף. אם צריך לבדוק אותי, אנא עשו זאת בזהירות ותתאמו איתי לפני כל מגע."\n\n• יש לי זכות לבדיקה ידנית בזהירות ולסמן אזורים אסורים.\n• אפשר לבקש לשבת במהלך הבדיקה.\n• אם מתחילה סחרחורת — אמור מיד "I need to sit down" ובקש מים.',
    body_en: 'Statement to show (English):\n"I have CRPS (Complex Regional Pain Syndrome). My left leg is extremely sensitive and must not be touched — contact may cause me to faint. If you need to screen me, please do it carefully and coordinate with me before any contact."\n\n• I have the right to careful manual screening and to mark off-limits areas.\n• I may request to sit during screening.\n• If dizziness starts — say "I need to sit down" and ask for water.',
  },
  phrases: {
    section: 'phrases',
    title_he: '🗣️ משפטים מוכנים לאנגלית',
    title_en: 'Ready-made English phrases',
    needs_disclaimer: false,
    body_he: 'הראה/קרא את המשפטים האלה לפי הצורך:\n\n• אני נוסע עם מוגבלות וזקוק לסיוע.\n  → I am a passenger with a disability and I need assistance.\n• יש לי אישור מראש לסיוע — הנה המסמך.\n  → I have pre-approved special assistance — here is the document.\n• זהו כיסא גלגלים חשמלי. הנה אישור הסוללות באנגלית.\n  → This is an electric wheelchair. Here is the battery approval in English.\n• אנא שימו תג על הכיסא שיוחזר אליי עד דלת המטוס.\n  → Please tag my wheelchair so it is returned to me at the aircraft door.\n• אני זקוק לכיסא שלי בכל עצירת ביניים.\n  → I need my wheelchair at every stopover.\n• אני לא מבין, אפשר לדבר לאט יותר בבקשה?\n  → I don’t understand, can you please speak more slowly?\n• אפשר עזרה של מישהו שדובר עברית?\n  → Is there someone who speaks Hebrew who can help?',
    body_en: '',
  },
};

const MENU_HE = [
  '✈️ מלווה טיסה — בחר נושא:',
  '',
  '/flight checklist — צ׳ק-ליסט לפני הטיסה',
  '/flight docs — מסמכים לארוז',
  '/flight wheelchair — כיסא וסוללות',
  '/flight rights — הזכויות שלי',
  '/flight security — הצהרת CRPS לביטחון',
  '/flight phrases — משפטים באנגלית',
  '',
  '🎙️ עזרה חיה: /flight_on כדי שאתרגם מילה-במילה מה שאומרים לך (אנגלית→עברית). /flight_off לכיבוי.',
].join('\n');

module.exports = { DISCLAIMER_HE, DISCLAIMER_EN, MEDICAL_LEGAL_SECTIONS, SECTIONS, MENU_HE };
