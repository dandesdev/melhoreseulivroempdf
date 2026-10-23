import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { strings, type Language, type Strings } from "../i18n";

export type Theme = "light" | "dark";

type Preferences = {
  lang: Language;
  setLang: (lang: Language) => void;
  t: Strings;
  theme: Theme;
  toggleTheme: () => void;
};

const PreferencesContext = createContext<Preferences | undefined>(undefined);

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export function PreferencesProvider({ children }: { children: ReactNode }) {
  // The theme follows the system until the user picks one with the toggle.
  const [saved, setSaved] = useState<Theme | null>(() => localStorage.getItem("theme") as Theme | null);
  const [system, setSystem] = useState<Theme>(() => (systemDark() ? "dark" : "light"));
  const theme = saved ?? system;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#080a1f" : "#f7f8fa");
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    // Picking the system's own theme goes back to following the system.
    if (next === system) {
      localStorage.removeItem("theme");
      setSaved(null);
    } else {
      localStorage.setItem("theme", next);
      setSaved(next);
    }
  };

  const [lang, setLangState] = useState<Language>(() => {
    const stored = localStorage.getItem("lang") as Language | null;
    if (stored === "br" || stored === "en") return stored;
    return navigator.language.toLowerCase().startsWith("en") ? "en" : "br";
  });

  useEffect(() => {
    document.documentElement.lang = lang === "br" ? "pt-BR" : "en";
    document.title = strings[lang].docTitle;
  }, [lang]);

  const setLang = (next: Language) => {
    localStorage.setItem("lang", next);
    setLangState(next);
  };

  return (
    <PreferencesContext.Provider value={{ lang, setLang, t: strings[lang], theme, toggleTheme }}>
      {children}
    </PreferencesContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePreferences() {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error("usePreferences must be used inside PreferencesProvider");
  return ctx;
}
