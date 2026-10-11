import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/shared/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border whitespace-nowrap transition-[color,box-shadow,background-color,border-color] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-primary-fill/20 bg-primary-fill text-primary-foreground [a&]:hover:bg-primary-hover",
        secondary:
          "border-border/60 bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "border-destructive/20 bg-destructive text-white dark:text-primary-foreground focus-visible:ring-destructive/20 [a&]:hover:bg-destructive/90",
        outline:
          "border-border/70 bg-background/70 text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost:
          "border-transparent bg-transparent [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
        tint: "border-transparent bg-primary-fill text-primary-foreground",
        // Semantic variants — monochromatic warm palette
        model: "border-[#C8B9A8]/50 dark:border-[#6c6256]/50 bg-border text-primary [a&]:hover:bg-border/80",
        config: "border-border/60 bg-muted text-[var(--text-2)] [a&]:hover:bg-muted/80",
        meta: "border-border-subtle/50 bg-background text-muted-foreground [a&]:hover:bg-background/80",
      },
      size: {
        sm: "px-2 py-0.5 text-[0.625rem] font-medium",
        md: "px-2.5 py-1 text-xs font-semibold",
        lg: "px-3 py-1.5 text-sm font-semibold",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  },
);

function Badge({
  className,
  variant = "default",
  size = "md",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge };
