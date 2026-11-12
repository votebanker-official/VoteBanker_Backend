async function main() {
  const home = await fetch("http://localhost:59816/");
  const html = await home.text();
  const bootstrap = html.match(/flutter_bootstrap\.js[^"']*/);
  console.log("bootstrap", bootstrap && bootstrap[0]);
  const script = await fetch("http://localhost:59816/flutter_bootstrap.js");
  const body = await script.text();
  const main = body.match(/main\.dart\.js[^"']*/);
  console.log("mainRef", main && main[0]);
  const jsUrl = "http://localhost:59816/" + (main ? main[0].split("?")[0] : "main.dart.js");
  const js = await (await fetch(jsUrl)).text();
  console.log(
    JSON.stringify({
      bytes: js.length,
      sendsProfileReturn: js.includes("/profile"),
      hasCompleteSocial: js.includes("completeSocialLaunch"),
      hasAuthTicket: js.includes("auth_ticket"),
    })
  );
}

main().catch((error) => {
  console.log(error && error.message ? error.message : error);
  process.exit(1);
});
