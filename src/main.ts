import "./redactor/ui.css";
import { mountRedactor } from "./redactor/ui";

const root = document.querySelector("#app");
if (root instanceof HTMLElement) mountRedactor(root);
