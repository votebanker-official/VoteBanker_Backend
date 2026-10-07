const DESIGNATIONS = ["MLA", "MP", "Minister", "Councillor", "Mayor", "Other"];

function composeLetter(request) {
  const designation = displayDesignation(request);
  const date = formatLetterDate(request.date);
  const lines = [
    `Date: ${date}`,
    "",
    "To,",
    request.politicianName,
    designation,
    request.constituency,
    "",
    `Subject: ${request.subject}`,
    "",
    `Respected ${designation} ${request.politicianName},`,
    "",
    `I am writing to you regarding ${request.purpose}.`,
    "",
    request.message.trim(),
    "",
    "I kindly request you to consider this matter and take the necessary action at the earliest possible convenience.",
    "",
    "Thank you for your time and consideration.",
    "",
    "Yours sincerely,",
    request.senderName,
  ];

  if (request.mobile) {
    lines.push(request.mobile);
  }
  if (request.email) {
    lines.push(request.email);
  }
  if (request.senderAddress) {
    lines.push(request.senderAddress);
  }

  return letterResult(request, lines.join("\n"), "mock");
}

function letterResult(request, text, source) {
  return {
    text: String(text || "").trim(),
    source,
    date: request.date,
    senderName: request.senderName,
    politicianName: request.politicianName,
    designation: displayDesignation(request),
    constituency: request.constituency,
    subject: request.subject,
  };
}

function displayDesignation(request) {
  if (request.designation === "Other") {
    return request.designationDetail || "Representative";
  }
  return request.designation;
}

function formatLetterDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) {
    return String(value || "");
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

module.exports = {
  DESIGNATIONS,
  composeLetter,
  letterResult,
  displayDesignation,
  formatLetterDate,
};
