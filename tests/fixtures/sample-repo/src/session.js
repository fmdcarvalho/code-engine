import { authenticateUser } from "./auth.js";
import { loadTask } from "./tasks.js";

export function buildSession(request) {
  const user = authenticateUser(request);
  return {
    user,
    task: loadTask(request.taskId),
  };
}
