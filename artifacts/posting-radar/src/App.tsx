import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, Show, useAuth, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Redirect, Route, Switch, useLocation, Router as WouterRouter } from "wouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";
import Portal from "@/pages/portal";
import Tracker from "@/pages/tracker";
import PreferencesPage from "@/pages/preferences";
import History from "@/pages/history";
import HowItWorks from "@/pages/how-it-works";
import { Logo, Shell } from "@/components/shell";
import { AccountGate, TrackerSignInPrompt } from "@/components/guest";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
}

if (!clerkPubKey) throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(12 84% 50%)",
    colorForeground: "hsl(228 42% 14%)",
    colorMutedForeground: "hsl(228 12% 40%)",
    colorDanger: "hsl(352 72% 44%)",
    colorBackground: "hsl(40 40% 99%)",
    colorInput: "hsl(40 30% 96%)",
    colorInputForeground: "hsl(228 42% 14%)",
    colorNeutral: "hsl(228 42% 14%)",
    fontFamily: "'Geist', ui-sans-serif, sans-serif",
    borderRadius: "0.375rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[hsl(40_40%_99%)] border border-[hsl(36_18%_84%)] rounded-md w-[420px] max-w-full overflow-hidden shadow-none",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "font-['Bricolage_Grotesque'] text-2xl font-extrabold text-[hsl(228_42%_14%)]",
    headerSubtitle: "text-[hsl(228_12%_40%)]",
    socialButtonsBlockButtonText: "text-[hsl(228_42%_14%)] font-medium",
    formFieldLabel: "text-[hsl(228_42%_14%)] font-medium",
    footerActionLink: "text-[hsl(12_84%_46%)] font-semibold",
    footerActionText: "text-[hsl(228_12%_40%)]",
    dividerText: "text-[hsl(228_12%_40%)] font-mono text-[11px] uppercase",
    identityPreviewEditButton: "text-[hsl(12_84%_46%)]",
    formFieldSuccessText: "text-[hsl(168_55%_28%)]",
    alertText: "text-[hsl(228_42%_14%)]",
    logoBox: "h-10 justify-start",
    logoImage: "h-10 w-10",
    socialButtonsBlockButton: "border border-[hsl(36_18%_80%)] bg-[hsl(40_30%_96%)] rounded-sm",
    formButtonPrimary: "bg-[hsl(12_84%_50%)] text-[hsl(40_40%_98%)] rounded-sm shadow-none",
    formFieldInput: "bg-[hsl(40_30%_96%)] border-[hsl(36_16%_78%)] rounded-sm text-[hsl(228_42%_14%)]",
    footerAction: "bg-transparent",
    dividerLine: "bg-[hsl(36_18%_84%)]",
    alert: "border border-[hsl(352_72%_44%/.3)] bg-[hsl(352_72%_44%/.05)] rounded-sm",
    otpCodeFieldInput: "border-[hsl(36_16%_78%)] text-[hsl(228_42%_14%)]",
    formFieldRow: "gap-2",
    main: "gap-5",
  },
};

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grain gridlines flex min-h-[100dvh] flex-col items-center justify-center gap-6 bg-background px-4 py-10">
      <a href={basePath || "/"} aria-label="Posting Radar home"><Logo /></a>
      {children}
      <p className="max-w-sm text-center font-mono text-[11px] text-muted-foreground">Your tracker, preferences and run history belong to this account only.</p>
    </div>
  );
}
function SignInPage() {
  return <AuthFrame><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></AuthFrame>;
}
function SignUpPage() {
  return <AuthFrame><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></AuthFrame>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) qc.clear();
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);
  // Second signal: useAuth userId. Clears only on real identity change (cookie and drafts untouched).
  const { isLoaded, userId } = useAuth();
  const prevAuthRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isLoaded) return;
    const id = userId ?? null;
    if (prevAuthRef.current !== undefined && prevAuthRef.current !== id) qc.clear();
    prevAuthRef.current = id;
  }, [isLoaded, userId, qc]);
  return null;
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in"><Redirect to="/user-portal" /></Show>
      <Show when="signed-out"><Landing /></Show>
    </>
  );
}

function protect(Page: ComponentType) {
  return function Protected() {
    return (
      <>
        <Shell><AccountGate><Page /></AccountGate></Shell>
      </>
    );
  };
}
function TrackerR() {
  return (
    <Shell>
      <Show when="signed-in"><AccountGate><Tracker /></AccountGate></Show>
      <Show when="signed-out"><TrackerSignInPrompt /></Show>
    </Shell>
  );
}
const PortalR = protect(Portal), PrefsR = protect(PreferencesPage), HistoryR = protect(History), HowR = protect(HowItWorks);

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: "Back to your radar", subtitle: "Sign in to see what your last sweep found" } },
        signUp: { start: { title: "Set up your radar", subtitle: "One account, your own tracker and run history" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route path="/user-portal" component={PortalR} />
              <Route path="/tracker" component={TrackerR} />
              <Route path="/preferences" component={PrefsR} />
              <Route path="/history" component={HistoryR} />
              <Route path="/how-it-works" component={HowR} />
              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
