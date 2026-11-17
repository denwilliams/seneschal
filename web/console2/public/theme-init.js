// Apply the saved or system theme before first paint, so there is no flash. A separate file, not an inline script,
// because the console's Content-Security-Policy allows scripts from its own origin only.
try {
  var saved = localStorage.getItem("console2-theme");
  var dark = saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
} catch (e) {}
