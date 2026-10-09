import { onDestroy, onInit, ref } from "@li3/web";

export default function setup() {
  const activeSection = ref("runs");
  const user = ref({ name: "", email: "", role: "" });
  const oidcProviderUrl = ref("");
  const userAuthenticated = ref(false);
  const userInitial = ref("U");

  const handleSkipKeydown = (event) => {
    if (!event.target.closest?.("[data-skip-to-content]") || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    const mainContent = document.getElementById("main-content");
    mainContent?.focus({ preventScroll: true });
    mainContent?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const syncSection = () => {
    const path = window.location.pathname;
    activeSection.value = path.startsWith("/settings")
      ? "settings"
      : path.startsWith("/workflows")
        ? "workflows"
        : "runs";
  };

  const setActive = (section) => {
    activeSection.value = section;
  };

  onInit(() => {
    syncSection();
    window.addEventListener("popstate", syncSection);
    document.addEventListener("keydown", handleSkipKeydown);
    void fetch("/api/auth/session", { credentials: "same-origin", headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((session) => {
        if (!session?.authenticated || !session.user) return;
        user.value = session.user;
        oidcProviderUrl.value = session.providerUrl || "";
        userAuthenticated.value = true;
        userInitial.value = String(session.user.name || session.user.email || "U")
          .trim()
          .slice(0, 1)
          .toUpperCase();
      })
      .catch((error) => console.error("Unable to load the signed-in profile", error));
  });

  onDestroy(() => {
    window.removeEventListener("popstate", syncSection);
    document.removeEventListener("keydown", handleSkipKeydown);
  });

  return { activeSection, user, userAuthenticated, userInitial, oidcProviderUrl, setActive };
}
