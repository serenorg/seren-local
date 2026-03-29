// ABOUTME: Main application component with AppShell layout (ThreadSidebar + ThreadContent + SlidePanel).
// ABOUTME: Initializes auth, wallet, memory, telemetry, and updater services.

import {
  createEffect,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { AboutDialog } from "@/components/common/AboutDialog";
import { UpdateIndicator } from "@/components/common/UpdateIndicator";
import { LowBalanceModal } from "@/components/common/LowBalanceWarning";
import { X402PaymentApproval } from "@/components/mcp/X402PaymentApproval";
import { GatewayToolApproval } from "@/components/gateway/GatewayToolApproval";
import { DailyClaimPopup } from "@/components/wallet/DailyClaimPopup";
import { AppShell } from "@/components/layout/AppShell";
import { connectToRuntime, storeOAuthCredentials } from "@/lib/bridge";
import { shortcuts } from "@/lib/shortcuts";
import { Phase3Playground } from "@/playground/Phase3Playground";
import { initAutoTopUp } from "@/services/autoTopUp";
import { syncMemories } from "@/services/memory";
import { getPendingOAuthProvider, handleOAuthCallback } from "@/services/oauth";
import { telemetry } from "@/services/telemetry";
import {
  authStore,
  checkAuth,
  logout,
  setAuthenticated,
} from "@/stores/auth.store";
import { autocompleteStore } from "@/stores/autocomplete.store";
import { chatStore } from "@/stores/chat.store";
import { providerStore } from "@/stores/provider.store";
import { loadAllSettings } from "@/stores/settings.store";
import { updaterStore } from "@/stores/updater.store";
import {
  checkDailyClaim,
  resetWalletState,
  startAutoRefresh,
  startDailyClaimPolling,
  stopAutoRefresh,
} from "@/stores/wallet.store";
import "./styles.css";

// Initialize telemetry early to capture startup errors
telemetry.init();

function App() {
  if (shouldRenderPhase3Playground()) {
    return <Phase3Playground />;
  }

  onMount(async () => {
    // Handle OAuth callback if returning from provider authorization
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (code && state && window.location.pathname === "/oauth/callback") {
      try {
        const pendingProvider = getPendingOAuthProvider();
        if (pendingProvider) {
          const credentials = await handleOAuthCallback(code, state);
          await storeOAuthCredentials(
            pendingProvider,
            JSON.stringify(credentials),
          );
          await providerStore.configureOAuthProvider(pendingProvider);
        }
      } catch (err) {
        console.error("[App] OAuth callback failed:", err);
      }
      // Clear the callback URL params
      window.history.replaceState({}, "", "/");
    }

    // Try connecting to local runtime (non-blocking)
    connectToRuntime().then((connected) => {
      if (connected) {
        console.log("[App] Local runtime connected");
      }
    });

    checkAuth();
    updaterStore.initUpdater();

    // Load all settings including app settings (chatDefaultModel, etc.) and MCP settings
    await loadAllSettings();

    // Load provider settings - this restores the last used model from previous session
    await providerStore.loadSettings();

    // Sync chatStore with the active model from provider store
    chatStore.setModel(providerStore.activeModel);

    // Initialize keyboard shortcuts (AppShell registers its own panel shortcuts)
    shortcuts.init();
  });

  onCleanup(() => {
    shortcuts.destroy();
  });

  // Store cleanup function for auto top-up
  let cleanupAutoTopUp: (() => void) | null = null;

  // Initialize wallet and AI features when authenticated
  createEffect((prev) => {
    const isAuth = authStore.isAuthenticated;

    // Only run if auth state actually changed
    if (isAuth === prev) return isAuth;

    if (isAuth) {
      console.log("[App] User authenticated, starting services...");

      // Use untrack to prevent reactive dependencies
      untrack(() => {
        startAutoRefresh();
        autocompleteStore.enable();
        // Store cleanup to prevent effect accumulation
        cleanupAutoTopUp = initAutoTopUp();
        checkDailyClaim();
        startDailyClaimPolling();
        // Push any locally-cached memories that failed to reach cloud (e.g. cold start)
        void syncMemories();
      });
    } else {
      console.log("[App] User logged out, stopping services...");
      untrack(() => {
        // Clean up auto top-up effect
        if (cleanupAutoTopUp) {
          cleanupAutoTopUp();
          cleanupAutoTopUp = null;
        }
        stopAutoRefresh();
        resetWalletState();
        autocompleteStore.disable();
      });
    }

    return isAuth;
  }, authStore.isAuthenticated);

  const handleLoginSuccess = () => {
    setAuthenticated({ id: "", email: "", name: "" });
  };

  const handleLogout = async () => {
    await logout();
  };

  return (
    <Show
      when={!authStore.isLoading}
      fallback={
        <div class="flex flex-col items-center justify-center h-screen gap-4 text-muted-foreground">
          <div class="loading-spinner" />
          <p>Loading...</p>
        </div>
      }
    >
      <AppShell
        onLoginSuccess={handleLoginSuccess}
        onLogout={handleLogout}
      />
      <UpdateIndicator />
      <LowBalanceModal />
      <DailyClaimPopup />
      <X402PaymentApproval />
      <GatewayToolApproval />
      <AboutDialog />
    </Show>
  );
}

export default App;

function shouldRenderPhase3Playground(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("test") === "phase3";
}
