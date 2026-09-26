export const effortLabels: Record<string, string> = {
  none: "Nenhum",
  minimal: "Mínimo",
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
  xhigh: "Muito alto",
  max: "Máximo",
  ultra: "Ultra",
};
export function effortLabel(value: string) {
  return effortLabels[value] || value;
}
