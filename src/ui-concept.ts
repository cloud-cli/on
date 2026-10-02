import appSource from "../docs/ui-concept/app.js?raw";
import page from "../docs/ui-concept/index.html?raw";
import styles from "../docs/ui-concept/style.css?raw";

export function embedUiConcept(pageSource: string, stylesSource: string, appSource: string): string {
  const previewScript = `const isDemoRequested = new URLSearchParams(window.location.search).get("demo") === "1";
const isLocalPreview = window.location.protocol === "file:" || /localhost|127\\.0\\.0\\.1|::1/.test(window.location.hostname);

if (!isDemoRequested && !isLocalPreview) {
  void import("/preview-live.mjs").then(({ mountLivePreview }) => mountLivePreview()).catch((error) => {
    const main = document.querySelector("#main");
    if (!main) {
      return;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "empty-state";
    const heading = document.createElement("h1");
    heading.textContent = "Preview unavailable";
    const message = document.createElement("p");
    message.textContent = String(error.message || error);
    const retry = document.createElement("button");
    retry.className = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => window.location.reload());
    wrapper.append(heading, message, retry);
    main.replaceChildren(wrapper);
  });
} else {
${appSource}
}`;

  return pageSource
    .replace('<link rel="stylesheet" href="./style.css" />', `<style>${stylesSource}</style>`)
    .replace('<script src="./app.js" defer></script>', "")
    .replace("</body>", `<script>${previewScript}</script></body>`);
}

export const uiConceptPage = embedUiConcept(page, styles, appSource);
