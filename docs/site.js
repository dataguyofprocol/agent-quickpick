(function () {
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  if (/mac|iphone|ipad/i.test(platform)) return;
  document.querySelectorAll("[data-shortcut]").forEach(function (el) {
    el.textContent = "Ctrl+Shift+A";
  });
})();
