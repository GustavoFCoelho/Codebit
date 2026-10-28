import {
  startTransition,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type SetStateAction,
} from "react";

type Revision = { text: string; revision: number };

// Only the textarea participates in the urgent keystroke render. Consumers of
// its text (sidebar, toolbar, command palette) can render in a transition.
export function useEditorDraft() {
  const current = useRef<Revision>({ text: "", revision: 0 });
  const [value, publish] = useState(current.current);
  const replace = useCallback((text: SetStateAction<string>) => {
    const next = {
      text: typeof text === "function" ? text(current.current.text) : text,
      revision: current.current.revision + 1,
    };
    current.current = next;
    publish(next);
  }, []);
  const edit = useCallback((text: string) => {
    const next = { text, revision: current.current.revision + 1 };
    current.current = next;
    startTransition(() => publish(next));
    return next;
  }, []);
  return { text: value.text, replace, current, input: { value, edit } };
}

export function DraftInput({
  value,
  edit,
  onEdit,
  ...props
}: Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  value: Revision;
  edit: (text: string) => Revision;
  onEdit: (text: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useLayoutEffect(() => {
    // A delayed parent render must never overwrite a newer keystroke.
    setLocal((previous) =>
      value.revision > previous.revision ? value : previous,
    );
  }, [value]);
  return (
    <textarea
      {...props}
      value={local.text}
      onChange={(event) => {
        const text = event.target.value;
        setLocal(edit(text));
        onEdit(text);
      }}
    />
  );
}
