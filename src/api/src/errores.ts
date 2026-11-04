import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

// Contrato de error: { error: { codigo, mensaje, detalles? } } con el código HTTP que corresponda.
export class ErrorApi extends Error {
  constructor(
    public estado: number,
    public codigo: string,
    mensaje: string,
    public detalles?: unknown,
  ) {
    super(mensaje);
  }
}

export function manejarErrores(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        codigo: "solicitud_invalida",
        mensaje: "La solicitud no cumple el formato esperado.",
        detalles: err.issues.map((i) => ({ campo: i.path.join("."), mensaje: i.message })),
      },
    });
    return;
  }
  if (err instanceof ErrorApi) {
    res.status(err.estado).json({ error: { codigo: err.codigo, mensaje: err.message, detalles: err.detalles } });
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: { codigo: "json_invalido", mensaje: "El cuerpo no es un JSON válido." } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { codigo: "error_interno", mensaje: "Ocurrió un error inesperado." } });
}
