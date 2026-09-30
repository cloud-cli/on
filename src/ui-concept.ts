import appSource from "../docs/ui-concept/app.js?raw";
import page from "../docs/ui-concept/index.html?raw";
import styles from "../docs/ui-concept/style.css?raw";

export function embedUiConcept(pageSource: string, stylesSource: string, appSource: string): string {
  return pageSource
    .replace('<link rel="stylesheet" href="./style.css" />', `<style>${stylesSource}</style>`)
    .replace('<script src="./app.js" defer></script>', "")
    .replace("</body>", `<script>${appSource}</script></body>`);
}

export const uiConceptPage = embedUiConcept(page, styles, appSource);
