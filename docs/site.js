(function () {
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  if (!/mac|iphone|ipad/i.test(platform)) {
    document.querySelectorAll("[data-shortcut]").forEach(function (el) {
      el.textContent = "Ctrl+Shift+A";
    });
  }

  var video = document.querySelector(".demo-video");
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!video || reducedMotion || !("IntersectionObserver" in window)) return;

  var pausedByUser = false;
  video.addEventListener("pause", function () {
    if (!video.dataset.autoPausing) pausedByUser = true;
    delete video.dataset.autoPausing;
  });
  video.addEventListener("play", function () { pausedByUser = false; });

  new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting && !pausedByUser) {
        video.play().catch(function () {});
      } else if (!entry.isIntersecting && !video.paused) {
        video.dataset.autoPausing = "1";
        video.pause();
      }
    });
  }, { threshold: 0.4 }).observe(video);
})();
