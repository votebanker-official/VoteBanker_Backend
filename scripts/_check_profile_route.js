const urls = [
  "http://localhost:59816/",
  "http://localhost:59816/profile",
  "http://localhost:59816/profile?auth_ticket=abc",
];

async function main() {
  for (const url of urls) {
    const response = await fetch(url);
    const text = await response.text();
    const match = text.match(/<base href="([^"]*)"/);
    console.log(
      JSON.stringify({
        status: response.status,
        url,
        base: match ? match[1] : null,
        flutter: text.includes("flutter_bootstrap") || text.includes("main.dart.js"),
      })
    );
  }
}

main().catch((error) => {
  console.log(error.name);
  process.exit(1);
});
