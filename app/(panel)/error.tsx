"use client";

import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="rounded-xl border p-6">
      <h2 className="text-lg font-semibold">Não foi possível carregar esta área.</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Verifique a conexão e tente novamente. Nenhum lançamento é alterado por esta tela de erro.
      </p>
      <Button className="mt-4" onClick={reset}>Tentar novamente</Button>
    </div>
  );
}
