(() => {
  const nativeScrollIntoView = Element.prototype.scrollIntoView;

  Element.prototype.scrollIntoView = function scrollIntoView(options) {
    const timeline = this.closest?.("#timeline");
    if (timeline && this.classList?.contains("hour-card")) {
      const targetLeft = this.offsetLeft - (timeline.clientWidth - this.clientWidth) / 2;
      timeline.scrollTo({
        left: Math.max(0, targetLeft),
        behavior: options && typeof options === "object" ? options.behavior || "auto" : "auto"
      });
      return;
    }

    return nativeScrollIntoView.call(this, options);
  };
})();
