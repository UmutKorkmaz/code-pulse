(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const navToggle = document.querySelector(".nav-toggle");
  const navMenu = document.querySelector("#primary-nav");

  if (navToggle && navMenu) {
    const closeNav = () => {
      document.body.classList.remove("nav-open");
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.setAttribute("aria-label", "Open navigation");
    };

    navToggle.addEventListener("click", () => {
      const isOpen = document.body.classList.toggle("nav-open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
      navToggle.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
    });

    navMenu.addEventListener("click", (event) => {
      if (event.target.closest("a")) {
        closeNav();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeNav();
      }
    });
  }

  const revealItems = document.querySelectorAll("[data-reveal]");

  if (!reduceMotion && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.16, rootMargin: "0px 0px -8% 0px" },
    );

    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  }

  const activateTab = (tabs, panels, tab) => {
    tabs.forEach((item) => {
      const active = item === tab;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
    });

    panels.forEach((panel) => {
      const active = panel.id === tab.getAttribute("aria-controls");
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    });
  };

  document.querySelectorAll("[data-tabs]").forEach((tabsRoot) => {
    const tabs = Array.from(tabsRoot.querySelectorAll("[role='tab']"));
    const panels = Array.from(tabsRoot.querySelectorAll("[role='tabpanel']"));

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activateTab(tabs, panels, tab));

      tab.addEventListener("keydown", (event) => {
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
        if (!keys.includes(event.key)) {
          return;
        }

        event.preventDefault();
        let nextIndex = index;

        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;

        tabs[nextIndex].focus();
        activateTab(tabs, panels, tabs[nextIndex]);
      });
    });

    const syncHashToTab = () => {
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      const matchingPanel = panels.find((panel) => panel.id === hash);
      if (!matchingPanel) return;
      const matchingTab = tabs.find((tab) => tab.getAttribute("aria-controls") === hash);
      if (matchingTab) activateTab(tabs, panels, matchingTab);
    };

    syncHashToTab();
    window.addEventListener("hashchange", syncHashToTab);
  });
})();
