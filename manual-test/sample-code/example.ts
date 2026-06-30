/**
 * Example TypeScript file for testing ctrlyoke file attachment features.
 * This file demonstrates common TypeScript patterns.
 */

interface User {
  id: number;
  name: string;
  email: string;
  isActive: boolean;
}

class UserManager {
  private users: Map<number, User>;

  constructor() {
    this.users = new Map();
  }

  addUser(user: User): void {
    this.users.set(user.id, user);
  }

  getUser(id: number): User | undefined {
    return this.users.get(id);
  }

  getAllActiveUsers(): User[] {
    return Array.from(this.users.values()).filter((user) => user.isActive);
  }

  updateUser(id: number, updates: Partial<User>): boolean {
    const user = this.users.get(id);
    if (!user) {
      return false;
    }

    this.users.set(id, { ...user, ...updates });
    return true;
  }

  deleteUser(id: number): boolean {
    return this.users.delete(id);
  }
}

export { User, UserManager };
