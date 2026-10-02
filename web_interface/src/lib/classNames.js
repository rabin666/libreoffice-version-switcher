// Joins the truthy class names, so conditional modifiers read as a list.

export const classNames = (...names) => names.filter(Boolean).join(' ');
