import { Button } from "./Button";

export interface TabItem<TValue extends string> {
  label: string;
  value: TValue;
}

interface TabsProps<TValue extends string> {
  items: Array<TabItem<TValue>>;
  value: TValue;
  onChange: (value: TValue) => void;
}

export function Tabs<TValue extends string>({ items, value, onChange }: TabsProps<TValue>) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <Button
          aria-selected={item.value === value}
          className={item.value === value ? "is-active" : ""}
          key={item.value}
          onClick={() => onChange(item.value)}
          role="tab"
          type="button"
          variant="ghost"
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}
