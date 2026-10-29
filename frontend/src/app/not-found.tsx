import { MagnifyingGlassMinus } from "@/shared/ui/icons";
import { LinkButton } from "@/shared/ui/link-button";
import { msg } from "@/shared/lib/messages";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60dvh] gap-5 text-center px-4">
      <MagnifyingGlassMinus className="size-14 text-muted-foreground/40" />
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-foreground">{msg("not_found.title")}</h1>
        <p className="text-sm text-muted-foreground">{msg("not_found.description")}</p>
      </div>
      <LinkButton href="/" className="min-h-[44px]">
        {msg("not_found.back_dashboard")}
      </LinkButton>
    </div>
  );
}
