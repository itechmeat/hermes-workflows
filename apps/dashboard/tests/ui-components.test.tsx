import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, Badge, Field, PageHeader, Modal, Menu } from "../src/ui/components";

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
