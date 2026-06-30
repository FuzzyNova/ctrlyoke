"""
Example Python file for testing ctrlyoke file attachment features.
This file demonstrates common Python patterns.
"""

from typing import List, Optional
from dataclasses import dataclass


@dataclass
class Product:
    """Represents a product in an inventory system."""
    id: int
    name: str
    price: float
    quantity: int
    
    def is_in_stock(self) -> bool:
        """Check if product is available."""
        return self.quantity > 0
    
    def total_value(self) -> float:
        """Calculate total value of this product in inventory."""
        return self.price * self.quantity


class Inventory:
    """Manages product inventory."""
    
    def __init__(self):
        self.products: dict[int, Product] = {}
    
    def add_product(self, product: Product) -> None:
        """Add a product to inventory."""
        self.products[product.id] = product
    
    def get_product(self, product_id: int) -> Optional[Product]:
        """Retrieve a product by ID."""
        return self.products.get(product_id)
    
    def get_all_in_stock(self) -> List[Product]:
        """Get all products that are in stock."""
        return [p for p in self.products.values() if p.is_in_stock()]
    
    def total_inventory_value(self) -> float:
        """Calculate total value of all inventory."""
        return sum(p.total_value() for p in self.products.values())
    
    def restock(self, product_id: int, quantity: int) -> bool:
        """Add stock to an existing product."""
        product = self.products.get(product_id)
        if not product:
            return False
        
        product.quantity += quantity
        return True
