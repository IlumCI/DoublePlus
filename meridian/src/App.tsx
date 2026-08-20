import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppProvider } from "./lib/store";
import { NavBar } from "./components/NavBar";
import { ToastStack } from "./components/ui";
import { Explore } from "./pages/Explore";
import { TokenDetail } from "./pages/TokenDetail";
import { Create } from "./pages/Create";
import { Portfolio } from "./pages/Portfolio";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);
  return null;
}

function AnimatedRoutes() {
  const location = useLocation();
  return (
    <div key={location.pathname} className="route-fade">
      <Routes location={location}>
        <Route path="/" element={<Explore />} />
        <Route path="/token/:ticker" element={<TokenDetail />} />
        <Route path="/create" element={<Create />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <ScrollToTop />
        <NavBar />
        <AnimatedRoutes />
        <ToastStack />
      </BrowserRouter>
    </AppProvider>
  );
}
