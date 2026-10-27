"use client";
import { createContext, use } from "react";
const ReaderLanguage = createContext(null);
export function useReaderLanguage() { return use(ReaderLanguage); }
export default function ProviderReaderLanguage({ language, children }) { return <ReaderLanguage value={language}><div lang={language} className="contents">{children}</div></ReaderLanguage>; }
