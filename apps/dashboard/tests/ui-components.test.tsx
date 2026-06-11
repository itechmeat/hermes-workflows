import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Button,
  Badge,
  Checkbox,
  Field,
  Input,
  Menu,
  Modal,
  PageHeader,
  Select,
  type SelectItem,
  Switch,
  Textarea,
} from "../src/ui/components";

describe("Button", () => {
  it("defaults to type=button and the base class", () => {
    render(<Button>Go</Button>);
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn).toHaveAttribute("type", "button");
    expect(btn.className).toContain("hw-btn");
  });

  it("maps variant and size to modifier classes", () => {
    render(
      <Button variant="danger" size="sm">
        Delete
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).toContain("hw-btn--danger");
    expect(btn.className).toContain("hw-btn--sm");
  });

  it("honours an explicit submit type and forwards clicks", async () => {
    const onClick = vi.fn();
    render(
      <Button type="submit" variant="primary" onClick={onClick}>
        Save
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toHaveAttribute("type", "submit");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("Badge", () => {
  it("applies a tone modifier when given", () => {
    render(<Badge tone="completed">done</Badge>);
    expect(screen.getByText("done").className).toContain("hw-badge--completed");
  });

  it("renders a neutral pill without a tone", () => {
    render(<Badge>n/a</Badge>);
    const el = screen.getByText("n/a");
    expect(el.className).toContain("hw-badge");
    expect(el.className).not.toContain("hw-badge--");
  });
});

describe("Field", () => {
  it("associates a wrapping label with its control (implicit)", () => {
    render(
      <Field label="Title">
        <input aria-label="Title" />
      </Field>,
    );
    expect(screen.getByLabelText("Title")).toBeInTheDocument();
  });

  it("associates via htmlFor when an id is given", () => {
    render(
      <Field label="Mode" htmlFor="mode">
        <input id="mode" />
      </Field>,
    );
    expect(screen.getByLabelText("Mode")).toBeInTheDocument();
  });
});

describe("PageHeader", () => {
  it("renders the title and trailing actions", () => {
    render(<PageHeader title="Runs" actions={<button type="button">New</button>} />);
    expect(screen.getByRole("heading", { name: "Runs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });
});

describe("Modal", () => {
  it("renders a titled dialog with its children and footer", () => {
    render(
      <Modal title="Edit node" onClose={() => {}} footer={<button type="button">Done</button>}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Edit node" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("closes on the close button, on Escape, and on overlay click", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="X" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);

    const overlay = container.querySelector(".hw-modal-overlay") as HTMLElement;
    await userEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("does not close when the dialog body is clicked", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="X" onClose={onClose}>
        <p>body</p>
      </Modal>,
    );
    await userEvent.click(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Menu", () => {
  it("is closed until the trigger is clicked", () => {
    render(<Menu label="Add" items={[{ key: "a", label: "Alpha", onSelect: () => {} }]} />);
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("opens, selects an item, and closes", async () => {
    const onSelect = vi.fn();
    render(<Menu label="Add" items={[{ key: "a", label: "Alpha", onSelect }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Alpha" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("closes on Escape without selecting", async () => {
    const onSelect = vi.fn();
    render(<Menu label="Add" items={[{ key: "a", label: "Alpha", onSelect }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("anchors the popover to the trigger's right edge when align=end", async () => {
    const { container } = render(
      <Menu label="Add" align="end" items={[{ key: "a", label: "Alpha", onSelect: () => {} }]} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(container.querySelector(".hw-menu")?.className).toContain("hw-menu--end");
  });

  it("closes on an outside click without selecting", async () => {
    const onSelect = vi.fn();
    render(
      <div>
        <Menu label="Add" items={[{ key: "a", label: "Alpha", onSelect }]} />
        <button type="button">outside</button>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("Input", () => {
  it("renders an <input> with hw-input and is controlled via value/onChange", async () => {
    const onChange = vi.fn();
    render(<Input aria-label="Name" value="abc" onChange={onChange} />);
    const input = screen.getByLabelText("Name");
    expect(input.tagName).toBe("INPUT");
    expect(input.className).toContain("hw-input");
    expect(input).toHaveValue("abc");
    await userEvent.type(input, "d");
    expect(onChange).toHaveBeenCalled();
  });

  it("supports type=number and appends extra classes after hw-input", () => {
    render(
      <Input aria-label="Count" type="number" className="extra" value={3} onChange={() => {}} />,
    );
    const input = screen.getByLabelText("Count");
    expect(input).toHaveAttribute("type", "number");
    expect(input.className).toBe("hw-input extra");
  });
});

describe("Textarea", () => {
  it("renders a <textarea> with hw-input plus any extra class", () => {
    render(
      <Textarea aria-label="Prompt" className="hw-textarea--tall" value="x" onChange={() => {}} />,
    );
    const ta = screen.getByLabelText("Prompt");
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.className).toBe("hw-input hw-textarea--tall");
  });
});

describe("Checkbox", () => {
  it("renders a role=checkbox reflecting `checked` and toggles via onCheckedChange", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox checked={false} onCheckedChange={onCheckedChange}>
        Accept
      </Checkbox>,
    );
    const box = screen.getByRole("checkbox", { name: "Accept" });
    expect(box).toHaveAttribute("aria-checked", "false");
    await userEvent.click(box);
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  });
});

describe("Switch", () => {
  it("renders a role=switch reflecting `checked` and toggles via onCheckedChange", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch checked={false} onCheckedChange={onCheckedChange}>
        Fail open
      </Switch>,
    );
    const sw = screen.getByRole("switch", { name: "Fail open" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  });
});

const FRUITS: SelectItem[] = [
  { value: "", label: "(default)" },
  { value: "gala", label: "Gala" },
  { value: "fuji", label: "Fuji" },
];

function ControlledSelect({
  items,
  onValueChange,
}: {
  items: SelectItem[];
  onValueChange?: (v: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState("");
  return (
    <Select
      aria-label="Fruit"
      value={value}
      items={items}
      onValueChange={(v) => {
        setValue(v);
        onValueChange?.(v);
      }}
    />
  );
}

describe("Select", () => {
  it("shows the selected item's label and lets you pick another from the popup", async () => {
    const onValueChange = vi.fn();
    render(<ControlledSelect items={FRUITS} onValueChange={onValueChange} />);

    const trigger = screen.getByRole("combobox", { name: "Fruit" });
    expect(trigger).toHaveTextContent("(default)");

    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("option", { name: "Fuji" }));

    expect(onValueChange).toHaveBeenCalledWith("fuji");
    expect(trigger).toHaveTextContent("Fuji");
  });

  it("renders group headings for grouped items", async () => {
    const grouped: SelectItem[] = [
      { value: "", label: "(default)" },
      { value: "gpt@openai", label: "gpt", group: "OpenAI" },
      { value: "opus@anthropic", label: "opus", group: "Anthropic" },
    ];
    render(<ControlledSelect items={grouped} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Fruit" }));
    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "gpt" })).toBeInTheDocument();
  });
});
