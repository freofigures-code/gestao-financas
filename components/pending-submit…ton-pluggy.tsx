"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

type PendingSubmitButtonProps = Omit<ComponentProps<typeof Button>, "type" | "children"> & {
  children: ReactNode;
  pendingText?: string;
};

export function PendingSubmitButton({
  children,
  pendingText = "Processando...",
  disabled,
  ...props
}: PendingSubmitButtonProps) {
  const { pending } = useFormStatus();
  const isDisabled = pending || disabled;

  return (
    <Button
      {...props}
      type="submit"
      disabled={isDisabled}
      aria-disabled={isDisabled}
      aria-busy={pending}
    >
      {pending ? (
        <>
          <span
            aria-hidden="true"
            className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px]"
          />
          {pendingText}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
