(function () {
  function addButton(node) {
    var parent = node.parentElement;
    if (parent && parent.classList.contains("kxm-diagram")) return parent;
    var wrap = document.createElement("div");
    wrap.className = "kxm-diagram";
    node.parentNode.insertBefore(wrap, node);
    wrap.appendChild(node);
    var button = document.createElement("button");
    button.type = "button";
    button.className = "kxm-fs";
    button.textContent = "Full screen";
    button.addEventListener("click", function () {
      if (typeof wrap.requestFullscreen === "function") {
        if (document.fullscreenElement === wrap) {
          document.exitFullscreen();
        } else {
          wrap.requestFullscreen();
        }
      }
      wrap.classList.toggle("kxm-fs-open");
    });
    wrap.appendChild(button);
    return wrap;
  }

  function boot() {
    var nodes = Array.prototype.filter.call(document.querySelectorAll(".mermaid"), function (node) {
      if (node.getAttribute("data-kxm-mermaid") === "1") return false;
      node.setAttribute("data-kxm-mermaid", "1");
      addButton(node);
      return true;
    });
    if (window.mermaid && !window.__kxmMermaidReady) {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: {
          darkMode: true,
          background: "#0e0d0b",
          primaryColor: "#3068da",
          primaryTextColor: "#f2eee7",
          primaryBorderColor: "#3068da",
          secondaryColor: "#0e0d0b",
          secondaryTextColor: "#f2eee7",
          secondaryBorderColor: "#3068da",
          tertiaryColor: "#0e0d0b",
          tertiaryTextColor: "#f2eee7",
          tertiaryBorderColor: "#3068da",
          lineColor: "#3068da",
          textColor: "#f2eee7",
          mainBkg: "#0e0d0b",
          nodeBorder: "#3068da",
          clusterBkg: "#0e0d0b",
          titleColor: "#f2eee7",
          edgeLabelBackground: "#0e0d0b",
          actorBorder: "#3068da",
          actorBkg: "#0e0d0b",
          actorTextColor: "#f2eee7",
          signalColor: "#3068da",
          signalTextColor: "#f2eee7",
          noteBkgColor: "#0e0d0b",
          noteTextColor: "#f2eee7",
          noteBorderColor: "#3068da",
        },
      });
      window.__kxmMermaidReady = true;
    }
    var pending = window.mermaid && nodes.length
      ? window.mermaid.run({ nodes: nodes, suppressErrors: true })
      : Promise.resolve();
    Promise.resolve(pending).then(function () {
      nodes.forEach(addButton);
    });
  }

  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(boot);
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
