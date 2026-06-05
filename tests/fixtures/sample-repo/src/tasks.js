const tasks = new Map();

export function saveTask(task) {
  tasks.set(task.id, {
    ...task,
    updatedAt: new Date().toISOString(),
  });
}

export function loadTask(id) {
  return tasks.get(id);
}
