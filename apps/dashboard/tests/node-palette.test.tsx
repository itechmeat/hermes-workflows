import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NodePalette } from "../src/editor/NodePalette";

describe("NodePalette", () => {
  it("renders an add button for every node type", () => {
    render(<NodePalette onAdd={() => {}} />);
    for (const label of ["Agent task", "Condition", "Human review", "Finish"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("emits the node type when a button is clicked", async () => {
    const onAdd = vi.fn();
    render(<NodePalette onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: "Condition" }));
    expect(onAdd).toHaveBeenCalledWith("condition");
  });
});
