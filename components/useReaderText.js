"use client";
import { useSubscribe } from "@/components/ProviderSubscribe";
import { useReaderLanguage } from "@/components/ProviderReaderLanguage";
import { getReaderText } from "@/lib/reader-languages";
export default function useReaderText(language) { const context = useSubscribe(); const local = useReaderLanguage(); return getReaderText(language ?? local ?? context?.language); }
