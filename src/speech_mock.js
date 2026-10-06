const DEPTH = {
  "2 minutes": 1,
  "5 minutes": 2,
  "10 minutes": 4,
  "15 minutes": 6,
};

const packs = {
  English: englishPack(),
  Kannada: kannadaPack(),
  Hindi: hindiPack(),
  Telugu: teluguPack(),
  Tamil: tamilPack(),
  Malayalam: malayalamPack(),
};

function composeMockSpeech(request) {
  const pack = packs[request.language] || packs.English;
  const points = extractPoints(request.prompt);
  const depth = DEPTH[request.duration] || 2;
  const typeLabel = pack.types[request.speechType] || request.speechType;
  const toneLabel = pack.tones[request.tone] || request.tone;
  const title = pack.title(shortTopic(points[0]));
  const sections = pack.headings.map((heading, index) => ({
    heading,
    content: sectionContent({
      pack,
      index,
      points,
      depth,
      variant: request.variant || 0,
      typeLabel,
      toneLabel,
      prompt: request.prompt,
    }),
  }));

  return {
    title,
    language: request.language,
    speechType: request.speechType,
    duration: request.duration,
    tone: request.tone,
    source: "mock",
    sections,
    fullText: renderFullText(title, sections),
  };
}

function sectionContent({ pack, index, points, depth, variant, typeLabel, toneLabel, prompt }) {
  const paragraphs = [];
  const lead = pack.leads[index]
    .replaceAll("{type}", typeLabel)
    .replaceAll("{tone}", toneLabel)
    .replaceAll("{prompt}", prompt);
  paragraphs.push(lead);

  for (let step = 0; step < depth; step += 1) {
    const point = points[(index + step) % points.length];
    const opener = pack.openers[(index + step + variant) % pack.openers.length];
    const frame = pack.frames[(index + step) % pack.frames.length];
    paragraphs.push(
      frame
        .replaceAll("{opener}", opener)
        .replaceAll("{point}", point)
        .replaceAll("{type}", typeLabel)
        .replaceAll("{tone}", toneLabel),
    );
  }

  if (depth >= 4) {
    const point = points[(index + variant) % points.length];
    paragraphs.push(pack.expand.replaceAll("{point}", point).replaceAll("{type}", typeLabel));
  }

  return paragraphs.join("\n\n");
}

function extractPoints(prompt) {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  const parts = cleaned
    .split(/\n+|•|;|(?<=[.?!])\s+|,\s+|\s+\band\b\s+/i)
    .map((part) => part.trim().replace(/^[-*]\s*/, ""))
    .filter((part) => part.length > 2);
  const unique = [];
  for (const part of parts) {
    if (!unique.some((item) => item.toLowerCase() === part.toLowerCase())) {
      unique.push(part);
    }
    if (unique.length === 8) {
      break;
    }
  }
  return unique.length > 0 ? unique : [cleaned];
}

function shortTopic(point) {
  const words = point.split(/\s+/).slice(0, 12);
  const text = words.join(" ");
  return text.length > 80 ? `${text.slice(0, 77).trim()}...` : text;
}

function renderFullText(title, sections) {
  const blocks = [title, ""];
  for (const section of sections) {
    blocks.push(section.heading, "", section.content, "");
  }
  return blocks.join("\n").trim();
}

function englishPack() {
  return {
    headings: [
      "Greeting / Opening",
      "Introduction",
      "Main topic",
      "Key points",
      "Development and policy",
      "Future priorities",
      "Civic participation",
      "Closing",
    ],
    openers: [
      "To begin with",
      "Looking more closely",
      "In practical terms",
      "For everyone gathered here",
      "As we look ahead",
      "Before I close",
    ],
    types: {
      "Public Meeting": "public meeting",
      "Constituency Meeting": "constituency meeting",
      Inauguration: "inauguration",
      "Press Conference": "press conference",
      "Policy Announcement": "policy announcement",
      "Youth Event": "youth event",
      "Women's Event": "women's event",
      "Community Meeting": "community meeting",
      "Development Update": "development update",
      Custom: "gathering",
    },
    tones: {
      Formal: "formal",
      Inspirational: "inspirational",
      Conversational: "conversational",
      "Development-focused": "development-focused",
      "Community-focused": "community-focused",
    },
    title: (topic) => `Address on ${topic}`,
    leads: [
      "Good day, and thank you for attending this {type}. I will speak in a {tone} way.",
      "This draft uses only the brief you supplied, and it does not add figures, schemes, dates, quotations, or results that were not given. The brief is: {prompt}",
      "The subject of this {type} is the topic named in that brief.",
      "These are the points named for the speech. Nothing beyond them is claimed as a completed result.",
      "Development and policy remarks stay inside the words you provided. No government scheme or statistic is introduced here.",
      "The look ahead repeats the priorities already named. It does not make a new promise.",
      "Civic participation means coming to public discussion, raising a concern through an open channel, and joining community problem-solving. This speech does not single out any person or group.",
      "Thank you for your time. I welcome questions and a respectful exchange on the points above.",
    ],
    frames: [
      "{opener}, we can discuss {point} in this {type}.",
      "{opener}, {point} belongs in the conversation because it was part of the brief.",
      "{opener}, I want the {tone} message around {point} to stay clear and general.",
      "{opener}, neighbours can respond to {point} by speaking in the open and helping with practical follow-up.",
    ],
    expand:
      "A longer treatment of {point} still has to stay general: describe the concern, invite people to add what they know, and agree on a public next step at this {type}. No unnamed achievement is attached to it.",
  };
}

function kannadaPack() {
  return {
    headings: [
      "ನಮಸ್ಕಾರ",
      "ಪರಿಚಯ",
      "ಮುಖ್ಯ ವಿಷಯ",
      "ಮುಖ್ಯ ಅಂಶಗಳು",
      "ಅಭಿವೃದ್ಧಿ ಮತ್ತು ನೀತಿ",
      "ಮುಂದಿನ ಆದ್ಯತೆಗಳು",
      "ನಾಗರಿಕ ಭಾಗವಹಿಸುವಿಕೆ",
      "ಮುಕ್ತಾಯ",
    ],
    openers: ["ಮೊದಲು", "ಇನ್ನಷ್ಟು ಹತ್ತಿರದಿಂದ", "ಪ್ರಾಯೋಗಿಕವಾಗಿ", "ಇಲ್ಲಿ ಸೇರಿದ ಎಲ್ಲರಿಗೂ", "ಮುಂದೆ ನೋಡುತ್ತಾ", "ಮುಗಿಸುವ ಮುನ್ನ"],
    types: {
      "Public Meeting": "ಸಾರ್ವಜನಿಕ ಸಭೆ",
      "Constituency Meeting": "ಕ್ಷೇತ್ರ ಸಭೆ",
      Inauguration: "ಉದ್ಘಾಟನೆ",
      "Press Conference": "ಪತ್ರಿಕಾಗೋಷ್ಠಿ",
      "Policy Announcement": "ನೀತಿ ಘೋಷಣೆ",
      "Youth Event": "ಯುವಕರ ಕಾರ್ಯಕ್ರಮ",
      "Women's Event": "ಮಹಿಳೆಯರ ಕಾರ್ಯಕ್ರಮ",
      "Community Meeting": "ಸಮುದಾಯ ಸಭೆ",
      "Development Update": "ಅಭಿವೃದ್ಧಿ ಮಾಹಿತಿ",
      Custom: "ಸಭೆ",
    },
    tones: {
      Formal: "ಔಪಚಾರಿಕ",
      Inspirational: "ಸ್ಫೂರ್ತಿದಾಯಕ",
      Conversational: "ಸಂವಾದಾತ್ಮಕ",
      "Development-focused": "ಅಭಿವೃದ್ಧಿ ಕೇಂದ್ರಿತ",
      "Community-focused": "ಸಮುದಾಯ ಕೇಂದ್ರಿತ",
    },
    title: (topic) => `${topic} ಕುರಿತ ಭಾಷಣ`,
    leads: [
      "ಎಲ್ಲರಿಗೂ ನಮಸ್ಕಾರ. ಈ {type}ಗೆ ಬಂದಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದ. ನಾನು {tone} ರೀತಿಯಲ್ಲಿ ಮಾತನಾಡುತ್ತೇನೆ.",
      "ಈ ಕರಡು ನೀವು ಕೊಟ್ಟ ಮಾಹಿತಿಯನ್ನೇ ಬಳಸುತ್ತದೆ. ಕೊಡದ ಅಂಕಿಅಂಶ, ಯೋಜನೆ, ದಿನಾಂಕ, ಉಲ್ಲೇಖ ಅಥವಾ ಫಲಿತಾಂಶವನ್ನು ಸೇರಿಸುವುದಿಲ್ಲ. ನೀವು ಕೊಟ್ಟ ವಿಷಯ: {prompt}",
      "ಈ {type}ಯ ವಿಷಯ ನೀವು ಹೆಸರಿಸಿದ ಅಂಶವೇ.",
      "ಭಾಷಣಕ್ಕೆ ನೀವು ಹೆಸರಿಸಿದ ಅಂಶಗಳು ಇವು. ಅವುಗಳನ್ನು ಮುಗಿದ ಸಾಧನೆ ಎಂದು ಹೇಳುವುದಿಲ್ಲ.",
      "ಅಭಿವೃದ್ಧಿ ಮತ್ತು ನೀತಿಯ ಮಾತು ನೀವು ಕೊಟ್ಟ ಪದಗಳಲ್ಲೇ ಇರುತ್ತದೆ. ಹೊಸ ಯೋಜನೆ ಅಥವಾ ಅಂಕಿಅಂಶವನ್ನು ಇಲ್ಲಿ ತರುವುದಿಲ್ಲ.",
      "ಮುಂದಿನ ನೋಟ ಈಗಾಗಲೇ ಹೆಸರಿಸಿದ ಆದ್ಯತೆಗಳನ್ನೇ ಮತ್ತೆ ಹೇಳುತ್ತದೆ. ಹೊಸ ಭರವಸೆ ನೀಡುವುದಿಲ್ಲ.",
      "ನಾಗರಿಕ ಭಾಗವಹಿಸುವಿಕೆ ಎಂದರೆ ಸಾರ್ವಜನಿಕ ಚರ್ಚೆಗೆ ಬರುವುದು, ತೆರೆದ ಮಾರ್ಗದಲ್ಲಿ ಕಳವಳ ಹೇಳುವುದು, ಮತ್ತು ಸಮುದಾಯದ ಸಮಸ್ಯೆ ಬಗೆಹರಿಸುವಿಕೆಯಲ್ಲಿ ಸೇರುವುದು. ಈ ಭಾಷಣ ಯಾರನ್ನೂ ಪ್ರತ್ಯೇಕಿಸುವುದಿಲ್ಲ.",
      "ನಿಮ್ಮ ಸಮಯಕ್ಕೆ ಧನ್ಯವಾದ. ಮೇಲಿನ ಅಂಶಗಳ ಬಗ್ಗೆ ಪ್ರಶ್ನೆ ಮತ್ತು ಗೌರವಯುತ ಮಾತುಕತೆಗೆ ಸ್ವಾಗತ.",
    ],
    frames: [
      "{opener}, ಈ {type}ಯಲ್ಲಿ {point} ಬಗ್ಗೆ ಮಾತನಾಡಬಹುದು.",
      "{opener}, {point} ಚರ್ಚೆಗೆ ಸೇರಿದೆ ಏಕೆಂದರೆ ಅದು ನೀವು ಕೊಟ್ಟ ವಿಷಯದ ಭಾಗ.",
      "{opener}, {point} ಸುತ್ತಲಿನ {tone} ಸಂದೇಶ ಸ್ಪಷ್ಟವಾಗಿ ಮತ್ತು ಸಾಮಾನ್ಯವಾಗಿ ಇರಲಿ.",
      "{opener}, {point} ಬಗ್ಗೆ ನೆರೆಹೊರೆಯವರು ಬಹಿರಂಗವಾಗಿ ಮಾತನಾಡಿ, ಪ್ರಾಯೋಗಿಕ ಮುಂದಿನ ಹೆಜ್ಜೆಯಲ್ಲಿ ಸೇರಬಹುದು.",
    ],
    expand:
      "{point} ಬಗ್ಗೆ ದೀರ್ಘವಾಗಿ ಹೇಳಿದರೂ ಅದು ಸಾಮಾನ್ಯವಾಗಿರಬೇಕು: ಕಳವಳವನ್ನು ವಿವರಿಸಿ, ಜನ ತಮಗೆ ತಿಳಿದದ್ದನ್ನು ಸೇರಿಸಲಿ, ಈ {type}ಯಲ್ಲಿ ಮುಂದಿನ ಸಾರ್ವಜನಿಕ ಹೆಜ್ಜೆಯನ್ನು ಒಪ್ಪಿಕೊಳ್ಳಿ. ಹೆಸರಿಸದ ಸಾಧನೆಯನ್ನು ಇದಕ್ಕೆ ಜೋಡಿಸುವುದಿಲ್ಲ.",
  };
}

function hindiPack() {
  return {
    headings: [
      "अभिवादन",
      "परिचय",
      "मुख्य विषय",
      "मुख्य बातें",
      "विकास और नीति",
      "आगे की प्राथमिकताएँ",
      "नागरिक भागीदारी",
      "समापन",
    ],
    openers: ["सबसे पहले", "थोड़ा और पास से", "व्यावहारिक रूप से", "यहाँ आए सभी लोगों के लिए", "आगे देखते हुए", "समापन से पहले"],
    types: {
      "Public Meeting": "जनसभा",
      "Constituency Meeting": "क्षेत्र की बैठक",
      Inauguration: "उद्घाटन",
      "Press Conference": "प्रेस वार्ता",
      "Policy Announcement": "नीति घोषणा",
      "Youth Event": "युवा कार्यक्रम",
      "Women's Event": "महिला कार्यक्रम",
      "Community Meeting": "सामुदायिक बैठक",
      "Development Update": "विकास की जानकारी",
      Custom: "सभा",
    },
    tones: {
      Formal: "औपचारिक",
      Inspirational: "प्रेरक",
      Conversational: "बातचीत जैसा",
      "Development-focused": "विकास-केंद्रित",
      "Community-focused": "समुदाय-केंद्रित",
    },
    title: (topic) => `${topic} पर भाषण`,
    leads: [
      "सभी को नमस्कार। इस {type} में आने के लिए धन्यवाद। मैं {tone} ढंग से बोलूँगा।",
      "यह मसौदा केवल आपके दिए विषय का उपयोग करता है। जो आँकड़ा, योजना, तारीख, उद्धरण या परिणाम नहीं दिया गया, उसे जोड़ा नहीं गया है। आपका विषय: {prompt}",
      "इस {type} का विषय वही है जो आपने नाम दिया।",
      "भाषण के लिए जो बातें दी गई हैं, वे ये हैं। इन्हें पूरा हो चुका काम नहीं कहा जा रहा।",
      "विकास और नीति की बात आपके दिए शब्दों तक रहती है। यहाँ कोई नई योजना या आँकड़ा नहीं लाया जाता।",
      "आगे की बात उन्हीं प्राथमिकताओं को दोहराती है जो पहले से नाम हैं। कोई नया वादा नहीं किया जाता।",
      "नागरिक भागीदारी का अर्थ है सार्वजनिक चर्चा में आना, खुले माध्यम से चिंता बताना, और सामुदायिक समस्या सुलझाने में शामिल होना। यह भाषण किसी व्यक्ति या समूह को अलग नहीं करता।",
      "आपके समय के लिए धन्यवाद। ऊपर की बातों पर प्रश्न और सम्मानजनक बातचीत का स्वागत है।",
    ],
    frames: [
      "{opener}, इस {type} में हम {point} पर बात कर सकते हैं।",
      "{opener}, {point} चर्चा में है क्योंकि वह आपके विषय का हिस्सा था।",
      "{opener}, {point} के आसपास {tone} संदेश साफ़ और सामान्य रहे।",
      "{opener}, {point} पर पड़ोसी खुले में बोलकर और व्यावहारिक अगले कदम में शामिल होकर जवाब दे सकते हैं।",
    ],
    expand:
      "{point} पर लंबी बात भी सामान्य रहनी चाहिए: चिंता बताएँ, लोग जो जानते हैं वह जोड़ें, और इस {type} में अगला सार्वजनिक कदम तय करें। कोई अनाम उपलब्धि इससे नहीं जोड़ी जाती।",
  };
}

function teluguPack() {
  return {
    headings: [
      "అభివాదం",
      "పరిచయం",
      "ముఖ్య అంశం",
      "ముఖ్య అంశాలు",
      "అభివృద్ధి మరియు విధానం",
      "రాబోయే ప్రాధాన్యతలు",
      "పౌర భాగస్వామ్యం",
      "ముగింపు",
    ],
    openers: ["మొదట", "మరింత దగ్గరగా", "ఆచరణలో", "ఇక్కడ ఉన్న అందరికీ", "ముందు చూస్తూ", "ముగించే ముందు"],
    types: {
      "Public Meeting": "బహిరంగ సభ",
      "Constituency Meeting": "నియోజకవర్గ సమావేశం",
      Inauguration: "ప్రారంభోత్సవం",
      "Press Conference": "పత్రికా సమావేశం",
      "Policy Announcement": "విధాన ప్రకటన",
      "Youth Event": "యువజన కార్యక్రమం",
      "Women's Event": "మహిళా కార్యక్రమం",
      "Community Meeting": "సముదాయ సమావేశం",
      "Development Update": "అభివృద్ధి సమాచారం",
      Custom: "సభ",
    },
    tones: {
      Formal: "అధికారిక",
      Inspirational: "ప్రేరణాత్మక",
      Conversational: "సంభాషణ",
      "Development-focused": "అభివృద్ధి కేంద్రిత",
      "Community-focused": "సముదాయ కేంద్రిత",
    },
    title: (topic) => `${topic} పై ప్రసంగం`,
    leads: [
      "అందరికీ నమస్కారం. ఈ {type}కు వచ్చినందుకు ధన్యవాదాలు. నేను {tone} పద్ధతిలో మాట్లాడతాను.",
      "ఈ చిత్తు మీరు ఇచ్చిన విషయాన్ని మాత్రమే వాడుతుంది. ఇవ్వని సంఖ్య, పథకం, తేదీ, ఉటంకం లేదా ఫలితాన్ని చేర్చదు. మీ విషయం: {prompt}",
      "ఈ {type} విషయం మీరు పేర్కొన్నదే.",
      "ప్రసంగానికి పేర్కొన్న అంశాలు ఇవి. వాటిని పూర్తయిన సాధనగా చెప్పడం లేదు.",
      "అభివృద్ధి మరియు విధానం మాట మీరు ఇచ్చిన పదాల్లోనే ఉంటుంది. కొత్త పథకం లేదా సంఖ్యను ఇక్కడ తేవడం లేదు.",
      "ముందు చూపు ఇప్పటికే పేర్కొన్న ప్రాధాన్యతలనే మళ్లీ చెబుతుంది. కొత్త వాగ్దానం ఇవ్వదు.",
      "పౌర భాగస్వామ్యం అంటే బహిరంగ చర్చకు రావడం, బహిరంగ మార్గంలో ఆందోళన చెప్పడం, సముదాయ సమస్య పరిష్కారంలో చేరడం. ఈ ప్రసంగం ఎవరినీ వేరు చేయదు.",
      "మీ సమయానికి ధన్యవాదాలు. పై అంశాలపై ప్రశ్నలు మరియు గౌరవపూర్వక మాటకు స్వాగతం.",
    ],
    frames: [
      "{opener}, ఈ {type}లో {point} గురించి మాట్లాడవచ్చు.",
      "{opener}, {point} చర్చలో ఉంది ఎందుకంటే అది మీ విషయంలో భాగం.",
      "{opener}, {point} చుట్టూ {tone} సందేశం స్పష్టంగా మరియు సాధారణంగా ఉండాలి.",
      "{opener}, {point} గురించి ఇరుగుపొరుగు వారు బహిరంగంగా మాట్లాడి, ఆచరణాత్మక తదుపరి అడుగులో చేరవచ్చు.",
    ],
    expand:
      "{point} గురించి ఎక్కువగా చెప్పినా అది సాధారణంగా ఉండాలి: ఆందోళన చెప్పండి, ప్రజలు తెలిసినది చేర్చనివ్వండి, ఈ {type}లో తదుపరి బహిరంగ అడుగు అంగీకరించండి. పేర్కొనని సాధనను దీనికి కలపడం లేదు.",
  };
}

function tamilPack() {
  return {
    headings: [
      "வாழ்த்து",
      "அறிமுகம்",
      "முக்கிய தலைப்பு",
      "முக்கிய குறிப்புகள்",
      "வளர்ச்சியும் கொள்கையும்",
      "வரும் முன்னுரிமைகள்",
      "குடிமைப் பங்கேற்பு",
      "நிறைவு",
    ],
    openers: ["முதலில்", "இன்னும் அருகில்", "நடைமுறையில்", "இங்கே கூடிய அனைவருக்கும்", "முன்னோக்கிப் பார்த்து", "முடிக்கும் முன்"],
    types: {
      "Public Meeting": "பொதுக்கூட்டம்",
      "Constituency Meeting": "தொகுதி கூட்டம்",
      Inauguration: "தொடக்க விழா",
      "Press Conference": "செய்தியாளர் சந்திப்பு",
      "Policy Announcement": "கொள்கை அறிவிப்பு",
      "Youth Event": "இளைஞர் நிகழ்வு",
      "Women's Event": "பெண்கள் நிகழ்வு",
      "Community Meeting": "சமூகக் கூட்டம்",
      "Development Update": "மேம்பாட்டுத் தகவல்",
      Custom: "கூட்டம்",
    },
    tones: {
      Formal: "முறையான",
      Inspirational: "ஊக்கமூட்டும்",
      Conversational: "உரையாடல்",
      "Development-focused": "மேம்பாடு சார்ந்த",
      "Community-focused": "சமூகம் சார்ந்த",
    },
    title: (topic) => `${topic} குறித்த உரை`,
    leads: [
      "அனைவருக்கும் வணக்கம். இந்த {type}க்கு வந்ததற்கு நன்றி. நான் {tone} முறையில் பேசுவேன்.",
      "இந்த வரைவு நீங்கள் கொடுத்த தகவலையே பயன்படுத்துகிறது. தரப்படாத எண், திட்டம், தேதி, மேற்கோள் அல்லது முடிவைச் சேர்க்காது. நீங்கள் கொடுத்த தலைப்பு: {prompt}",
      "இந்த {type}யின் பொருள் நீங்கள் குறிப்பிட்டதே.",
      "உரைக்குக் குறிப்பிட்ட குறிப்புகள் இவை. அவற்றை முடிந்த சாதனையாகச் சொல்லவில்லை.",
      "வளர்ச்சி மற்றும் கொள்கை பேச்சு நீங்கள் கொடுத்த சொற்களிலேயே இருக்கும். புதிய திட்டமோ எண்ணோ இங்கே வராது.",
      "வரவிருக்கும் பார்வை ஏற்கெனவே உள்ள முன்னுரிமைகளையே மீண்டும் சொல்கிறது. புதிய வாக்குறுதி இல்லை.",
      "குடிமைப் பங்கேற்பு என்றால் பொது விவாதத்திற்கு வருவது, திறந்த வழியில் கவலையைச் சொல்வது, சமூகச் சிக்கல் தீர்ப்பில் சேர்வது. இந்த உரை யாரையும் தனியே பிரிப்பதில்லை.",
      "உங்கள் நேரத்திற்கு நன்றி. மேலே உள்ள குறிப்புகள் குறித்து கேள்வியும் மரியாதையான உரையாடலும் வரவேற்கப்படுகின்றன.",
    ],
    frames: [
      "{opener}, இந்த {type}யில் {point} பற்றி பேசலாம்.",
      "{opener}, {point} உரையாடலில் உள்ளது ஏனென்றால் அது நீங்கள் கொடுத்த தலைப்பின் பகுதி.",
      "{opener}, {point} குறித்த {tone} செய்தி தெளிவாகவும் பொதுவாகவும் இருக்கட்டும்.",
      "{opener}, {point} குறித்து அயலவர்கள் வெளிப்படையாகப் பேசி, நடைமுறை அடுத்த அடியில் சேரலாம்.",
    ],
    expand:
      "{point} பற்றி நீளமாகப் பேசினாலும் அது பொதுவாக இருக்க வேண்டும்: கவலையைச் சொல்லுங்கள், மக்கள் தெரிந்ததைச் சேர்க்கட்டும், இந்த {type}யில் அடுத்த பொது அடியை ஒப்புக்கொள்ளுங்கள். பெயரிடாத சாதனை இதனுடன் இணைக்கப்படாது.",
  };
}

function malayalamPack() {
  return {
    headings: [
      "ആശംസ",
      "ആമുഖം",
      "പ്രധാന വിഷയം",
      "പ്രധാന കാര്യങ്ങൾ",
      "വികസനവും നയവും",
      "വരാനിരിക്കുന്ന മുൻഗണനകൾ",
      "പൗര പങ്കാളിത്തം",
      "സമാപനം",
    ],
    openers: ["ആദ്യം", "കൂടുതൽ അടുത്ത്", "പ്രായോഗികമായി", "ഇവിടെ ഒത്തുകൂടിയ എല്ലാവർക്കും", "മുന്നോട്ട് നോക്കി", "അവസാനിപ്പിക്കും മുമ്പ്"],
    types: {
      "Public Meeting": "പൊതുയോഗം",
      "Constituency Meeting": "മണ്ഡല യോഗം",
      Inauguration: "ഉദ്ഘാടനം",
      "Press Conference": "പത്രസമ്മേളനം",
      "Policy Announcement": "നയ പ്രഖ്യാപനം",
      "Youth Event": "യുവജന പരിപാടി",
      "Women's Event": "വനിതാ പരിപാടി",
      "Community Meeting": "സമൂഹ യോഗം",
      "Development Update": "വികസന വിവരം",
      Custom: "യോഗം",
    },
    tones: {
      Formal: "ഔപചാരിക",
      Inspirational: "പ്രചോദനാത്മക",
      Conversational: "സംഭാഷണ",
      "Development-focused": "വികസന കേന്ദ്രിത",
      "Community-focused": "സമൂഹ കേന്ദ്രിത",
    },
    title: (topic) => `${topic} സംബന്ധിച്ച പ്രസംഗം`,
    leads: [
      "എല്ലാവർക്കും നമസ്കാരം. ഈ {type}യിലേക്ക് വന്നതിന് നന്ദി. ഞാൻ {tone} രീതിയിൽ സംസാരിക്കും.",
      "ഈ കരട് നിങ്ങൾ നൽകിയ വിഷയം മാത്രം ഉപയോഗിക്കുന്നു. നൽകാത്ത കണക്ക്, പദ്ധതി, തീയതി, ഉദ്ധരണി, ഫലം എന്നിവ ചേർക്കുന്നില്ല. നിങ്ങളുടെ വിഷയം: {prompt}",
      "ഈ {type}യുടെ വിഷയം നിങ്ങൾ പറഞ്ഞതാണ്.",
      "പ്രസംഗത്തിന് പറഞ്ഞ കാര്യങ്ങൾ ഇവയാണ്. അവ പൂർത്തിയായ നേട്ടമാണെന്ന് പറയുന്നില്ല.",
      "വികസനവും നയവും സംബന്ധിച്ച വാക്ക് നിങ്ങൾ നൽകിയതിൽ തന്നെ നിൽക്കും. പുതിയ പദ്ധതിയോ കണക്കോ ഇവിടെ കൊണ്ടുവരുന്നില്ല.",
      "മുന്നോട്ടുള്ള നോട്ടം ഇതിനകം പറഞ്ഞ മുൻഗണനകൾ തന്നെ ആവർത്തിക്കുന്നു. പുതിയ വാഗ്ദാനമില്ല.",
      "പൗര പങ്കാളിത്തം എന്നാൽ പൊതു ചർച്ചയിൽ വരിക, തുറന്ന വഴിയിൽ ആശങ്ക പറയുക, സമൂഹ പ്രശ്നപരിഹാരത്തിൽ ചേരുക. ഈ പ്രസംഗം ആരെയും വേർതിരിക്കുന്നില്ല.",
      "നിങ്ങളുടെ സമയത്തിന് നന്ദി. മുകളിലെ കാര്യങ്ങളെക്കുറിച്ചുള്ള ചോദ്യത്തിനും മര്യാദയുള്ള സംഭാഷണത്തിനും സ്വാഗതം.",
    ],
    frames: [
      "{opener}, ഈ {type}യിൽ {point} ചർച്ച ചെയ്യാം.",
      "{opener}, {point} സംഭാഷണത്തിലുണ്ട് കാരണം അത് നിങ്ങൾ നൽകിയ വിഷയത്തിന്റെ ഭാഗമാണ്.",
      "{opener}, {point}യെക്കുറിച്ചുള്ള {tone} സന്ദേശം വ്യക്തവും പൊതുവായതും ആയിരിക്കട്ടെ.",
      "{opener}, {point}യെക്കുറിച്ച് അയൽക്കാർ തുറന്ന് സംസാരിച്ച് പ്രായോഗിക അടുത്ത ചുവടിൽ ചേരാം.",
    ],
    expand:
      "{point}യെക്കുറിച്ച് ദീർഘമായി പറഞ്ഞാലും അത് പൊതുവായി നിൽക്കണം: ആശങ്ക വിവരിക്കുക, ആളുകൾ അറിയാവുന്നത് ചേർക്കട്ടെ, ഈ {type}യിൽ അടുത്ത പൊതു ചുവട് യോജിക്കുക. പേരിടാത്ത നേട്ടം ഇതിനോട് ചേർക്കുന്നില്ല.",
  };
}

module.exports = {
  composeMockSpeech,
  extractPoints,
};
