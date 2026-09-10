import { beforeEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ModelSelector } from "@/components/ModelSelector";
import { getAIModelsForProvider } from "@/config/models.constants";

// Mirrors how the API setup page drives ModelSelector: the parent owns the
// model string and feeds every change straight back in as `selectedModel`.
function Harness({ initial }: { initial: string }) {
  const [model, setModel] = useState(initial);
  return (
    <MemoryRouter>
      <ModelSelector
        providerId="openrouter"
        type="ai"
        selectedModel={model}
        onModelChange={setModel}
      />
      <output data-testid="saved-model">{model}</output>
    </MemoryRouter>
  );
}

async function chooseCustomModelOption() {
  await userEvent.click(screen.getByRole("combobox"));
  await userEvent.click(
    await screen.findByRole("option", { name: /custom model/i })
  );
}

const customInput = () => screen.queryByPlaceholderText(/enter model name/i);

describe("ModelSelector custom model mode", () => {
  const listedModel = getAIModelsForProvider("openrouter")[0].id;

  beforeEach(() => {
    // happy-dom lacks the pointer-capture API Radix Select's item handler calls.
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  });

  it("opens the custom input when a listed model is currently selected", async () => {
    render(<Harness initial={listedModel} />);

    await chooseCustomModelOption();

    expect(customInput()).not.toBeNull();
  });

  it("reopens the custom input when a custom model is already saved", async () => {
    render(<Harness initial="acme/private-model" />);

    await chooseCustomModelOption();

    expect(customInput()).toHaveValue("acme/private-model");
  });

  it("keeps the input while the typed id passes through a listed id", async () => {
    render(<Harness initial="" />);
    await chooseCustomModelOption();

    await userEvent.type(customInput()!, `${listedModel}-custom`);

    expect(customInput()).toHaveValue(`${listedModel}-custom`);
    expect(screen.getByTestId("saved-model")).toHaveTextContent(
      `${listedModel}-custom`
    );
  });

  it("returns to the dropdown from the List button", async () => {
    render(<Harness initial="" />);
    await chooseCustomModelOption();

    await userEvent.click(screen.getByRole("button", { name: /list/i }));

    expect(customInput()).toBeNull();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });
});
