import Link from "next/link";
import { ArrowLeft, ArrowRight, List } from "@/shared/ui/icons";
import { AppMark } from "@/shared/ui/app-mark";
import { cn } from "@/shared/lib/utils";
import { DocsPageActions } from "./docs-page-actions";
import { DocsSearch } from "./docs-search";
import { DocsThemeToggle } from "./docs-theme-toggle";
import { DocsToc } from "./docs-toc";
import { DOCS_CHROME, fillChrome } from "../lib/chrome";
import type { DocsHeading } from "../lib/markdown";
import {
  DOCS_PAGES,
  DOCS_SECTIONS,
  docsHref,
  docsMarkdownHref,
  docsNeighbors,
  type DocsLocale,
  type DocsPage,
} from "../lib/nav";
import { getSiteUrl } from "@/shared/lib/site-config";

/** The page list, grouped by section. The current page is marked. */
function DocsNav({ locale, current }: { locale: DocsLocale; current: string }) {
  return (
    <nav aria-label={DOCS_CHROME[locale].menu} className="space-y-6 text-sm">
      {DOCS_SECTIONS.map((section) => (
        <div key={section.id}>
          <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {section.title[locale]}
          </p>
          <ul className="space-y-0.5">
            {DOCS_PAGES.filter((p) => p.section === section.id).map((p) => (
              <li key={p.slug}>
                <Link
                  href={docsHref(p.slug, locale)}
                  aria-current={p.slug === current ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-2 py-1.5 transition-colors",
                    p.slug === current
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {p.title[locale]}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** A long date in the page language, from YYYY-MM-DD. */
function formatDate(date: string, locale: DocsLocale): string {
  return new Intl.DateTimeFormat(locale === "he" ? "he-IL" : "en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * The docs frame: header with search, page list, the page, its table of
 * contents and prev/next links. Renders bare, outside the app chrome.
 */
export function DocsShell({
  locale,
  page,
  headings,
  markdown,
  children,
}: {
  locale: DocsLocale;
  page: DocsPage;
  headings: DocsHeading[];
  markdown: string;
  children: React.ReactNode;
}) {
  const t = DOCS_CHROME[locale];
  const dir = locale === "he" ? "rtl" : "ltr";
  const other: DocsLocale = locale === "he" ? "en" : "he";
  const section = DOCS_SECTIONS.find((s) => s.id === page.section);
  const { prev, next } = docsNeighbors(page.slug);
  const markdownHref = docsMarkdownHref(page.slug, locale);
  const PrevIcon = dir === "rtl" ? ArrowRight : ArrowLeft;
  const NextIcon = dir === "rtl" ? ArrowLeft : ArrowRight;

  return (
    <div lang={locale} dir={dir} className="min-h-dvh bg-background text-foreground">
      <a
        href="#docs-content"
        className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        {t.skip}
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[90rem] items-center gap-3 px-4 sm:px-6">
          <Link href={docsHref("", locale)} aria-label={t.home} className="flex shrink-0 items-center gap-2">
            <AppMark className="size-7" aria-hidden="true" />
            <span className="font-semibold" dir="ltr">
              {"Skynet"}
            </span>
            <span className="text-muted-foreground">{t.docs}</span>
          </Link>
          <div className="flex-1" />
          <div className="min-w-0 flex-1 sm:flex-none">
            <DocsSearch locale={locale} dir={dir} labels={t} />
          </div>
          <Link
            href={docsHref(page.slug, other)}
            hrefLang={other}
            lang={other}
            title={t.otherLanguage}
            className="hidden shrink-0 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground sm:block"
          >
            {t.otherLanguageName}
          </Link>
          <div className="hidden md:block">
            <DocsThemeToggle labels={t} />
          </div>
          <Link
            href="/"
            className="hidden shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover md:block"
          >
            {t.openApp}
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-[90rem] px-4 sm:px-6">
        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 overflow-y-auto py-8 pe-4 lg:block">
          <DocsNav locale={locale} current={page.slug} />
        </aside>

        <main id="docs-content" className="min-w-0 flex-1 py-8 lg:px-10">
          <details className="mb-6 rounded-lg border border-border lg:hidden">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
              <List className="size-4" aria-hidden="true" />
              {t.menu}
            </summary>
            <div className="border-t border-border p-3">
              <DocsNav locale={locale} current={page.slug} />
              <div className="mt-4 flex items-center gap-3 border-t border-border pt-4 sm:hidden">
                <Link href={docsHref(page.slug, other)} hrefLang={other} lang={other} className="text-sm">
                  {t.otherLanguageName}
                </Link>
              </div>
              <div className="mt-4 md:hidden">
                <DocsThemeToggle labels={t} />
              </div>
            </div>
          </details>

          <article className="mx-auto max-w-3xl">
            <p className="text-sm font-medium text-primary">{section?.title[locale]}</p>
            <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight sm:text-4xl">{page.title[locale]}</h1>
            <p className="mt-3 text-lg text-muted-foreground">{page.description[locale]}</p>
            <div className="mt-5">
              <DocsPageActions
                markdown={markdown}
                markdownHref={markdownHref}
                prompt={fillChrome(t.askPrompt, { url: `${getSiteUrl()}${markdownHref}` })}
                labels={t}
              />
            </div>

            <div className="docs-prose mt-8">{children}</div>

            <footer className="mt-12 border-t border-border pt-6">
              <p className="text-sm text-muted-foreground">
                {fillChrome(t.lastUpdated, { date: formatDate(page.updated, locale) })}
              </p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {prev ? (
                  <Link
                    href={docsHref(prev.slug, locale)}
                    rel="prev"
                    className="rounded-lg border border-border p-4 transition-colors hover:border-foreground/25"
                  >
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <PrevIcon className="size-3" aria-hidden="true" />
                      {t.previous}
                    </span>
                    <span className="mt-1 block font-medium">{prev.title[locale]}</span>
                  </Link>
                ) : (
                  <span />
                )}
                {next && (
                  <Link
                    href={docsHref(next.slug, locale)}
                    rel="next"
                    className="rounded-lg border border-border p-4 text-end transition-colors hover:border-foreground/25"
                  >
                    <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                      {t.next}
                      <NextIcon className="size-3" aria-hidden="true" />
                    </span>
                    <span className="mt-1 block font-medium">{next.title[locale]}</span>
                  </Link>
                )}
              </div>
            </footer>
          </article>
        </main>

        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-56 shrink-0 overflow-y-auto py-8 xl:block">
          <DocsToc headings={headings} title={t.onThisPage} />
        </aside>
      </div>
    </div>
  );
}
