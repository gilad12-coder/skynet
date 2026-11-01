import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/shared/lib/site-config";

const siteUrl = getSiteUrl();

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/login", "/docs-search", "/docs-md/"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
