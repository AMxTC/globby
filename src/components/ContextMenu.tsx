import { useEffect, useRef, useState, type ComponentType } from "react";
import { proxy, useSnapshot } from "valtio";
import { ChevronRight } from "lucide-react";

export type MenuIcon = ComponentType<{ size?: number; className?: string }>;

export type ContextMenuItem =
  | {
      label: string;
      icon?: MenuIcon;
      shortcut?: string;
      action: () => void;
      disabled?: boolean;
    }
  | {
      label: string;
      icon?: MenuIcon;
      disabled?: boolean;
      children: ContextMenuItem[];
    }
  | { separator: true };

export const contextMenuState = proxy({
  open: false,
  x: 0,
  y: 0,
  items: [] as ContextMenuItem[],
});

export function openContextMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
) {
  contextMenuState.x = x;
  contextMenuState.y = y;
  contextMenuState.items = items;
  contextMenuState.open = true;
}

export function closeContextMenu() {
  contextMenuState.open = false;
}

const itemClass =
  "flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-40 disabled:pointer-events-none transition-colors text-left";

function MenuItemList({ items }: { items: readonly ContextMenuItem[] }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const subTimeout = useRef<ReturnType<typeof setTimeout>>();

  function enterSub(i: number) {
    clearTimeout(subTimeout.current);
    setOpenSub(i);
  }
  function leaveSub() {
    subTimeout.current = setTimeout(() => setOpenSub(null), 150);
  }

  return (
    <>
      {items.map((item, i) => {
        if ("separator" in item) {
          return <div key={i} className="my-1 h-px bg-border" />;
        }

        if ("children" in item) {
          const Icon = item.icon;
          return (
            <div
              key={i}
              className="relative"
              onMouseEnter={() => !item.disabled && enterSub(i)}
              onMouseLeave={leaveSub}
            >
              <button
                className={itemClass}
                disabled={item.disabled}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {Icon && <Icon size={14} className="shrink-0" />}
                <span className="flex-1">{item.label}</span>
                <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
              </button>
              {openSub === i && (
                <div
                  className="absolute left-full top-0 min-w-[120px] rounded-md border border-border bg-background text-foreground shadow-md py-1"
                  onMouseEnter={() => enterSub(i)}
                  onMouseLeave={leaveSub}
                >
                  <MenuItemList items={item.children} />
                </div>
              )}
            </div>
          );
        }

        const Icon = item.icon;
        return (
          <button
            key={i}
            className={itemClass}
            disabled={item.disabled}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              item.action();
              closeContextMenu();
            }}
          >
            {Icon && <Icon size={14} className="shrink-0" />}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <span className="ml-auto text-xs text-muted-foreground pl-4">
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

export default function ContextMenu() {
  const snap = useSnapshot(contextMenuState);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!snap.open) return;

    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeContextMenu();
      }
    }
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        closeContextMenu();
      }
    }
    function onScroll() {
      closeContextMenu();
    }

    window.addEventListener("keydown", onEsc, true);
    window.addEventListener("pointerdown", onClickOutside, true);
    window.addEventListener("scroll", onScroll, true);

    return () => {
      window.removeEventListener("keydown", onEsc, true);
      window.removeEventListener("pointerdown", onClickOutside, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [snap.open]);

  // Clamp position to viewport
  useEffect(() => {
    if (!snap.open || !ref.current) return;
    const el = ref.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) {
      el.style.left = `${Math.max(0, vw - rect.width)}px`;
    }
    if (rect.bottom > vh) {
      el.style.top = `${Math.max(0, vh - rect.height)}px`;
    }
  }, [snap.open, snap.x, snap.y]);

  if (!snap.open) return null;

  return (
    <div
      ref={ref}
      className="fixed z-[200] min-w-[180px] rounded-md border border-border bg-background text-foreground shadow-md py-1"
      style={{ left: snap.x, top: snap.y }}
    >
      <MenuItemList items={snap.items} />
    </div>
  );
}
