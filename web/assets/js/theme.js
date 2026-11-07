/* ライト/ダーク切替 + 保存(localStorage, 既定はOS設定追従) */
"use strict";

(function () {
  const KEY = "sdj-theme";
  const saved = localStorage.getItem(KEY);
  const sys = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const theme = saved === "dark" || saved === "light" ? saved : sys;
  document.documentElement.dataset.theme = theme;

  const btn = document.getElementById("themeToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem(KEY, next);
    });
  }
})();
